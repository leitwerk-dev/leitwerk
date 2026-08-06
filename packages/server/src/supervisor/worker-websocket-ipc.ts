import {
	deserializeMessage,
	type IpcEnvelope,
	type ServerToWorkerMessage,
	serializeMessage,
} from "@leitwerk-dev/worker-protocol";
import { verifyWorkerConnectToken } from "./worker-connect-token.js";

export interface WorkerWebSocketLike {
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	on(event: "message", handler: (raw: Buffer | string | ArrayBuffer | Buffer[]) => void): void;
	on(event: "close", handler: (event?: { code?: number; reason?: string }) => void): void;
	on(event: "error", handler: (error: unknown) => void): void;
}

export interface WorkerWebSocketCallbacks {
	onEnvelope(envelope: IpcEnvelope): void;
	onInvalidOutput(): void;
	onRuntimeError(error: unknown): void;
}

export class WorkerOutboundBufferOverflowError extends Error {
	constructor(
		readonly instanceId: string,
		readonly workerId: string,
		readonly maxBufferedMessages: number,
	) {
		super(
			`Worker WebSocket outbound buffer overflow for process ${instanceId} worker ${workerId} (maxBufferedMessages=${maxBufferedMessages})`,
		);
		this.name = "WorkerOutboundBufferOverflowError";
	}
}

interface PendingWorkerConnection {
	instanceId: string;
	workerId: string;
	tokenHash: string;
	callbacks: WorkerWebSocketCallbacks;
	socket: WorkerWebSocketLike | null;
	socketAuthenticated: boolean;
	authTimer: ReturnType<typeof setTimeout> | null;
	outbound: string[];
}

function connectionKey(instanceId: string, workerId: string): string {
	return `${instanceId}:${workerId}`;
}

function rawToText(raw: Buffer | string | ArrayBuffer | Buffer[]): string {
	if (typeof raw === "string") {
		return raw;
	}
	if (Array.isArray(raw)) {
		return Buffer.concat(raw).toString("utf8");
	}
	if (raw instanceof ArrayBuffer) {
		return Buffer.from(raw).toString("utf8");
	}
	return raw.toString("utf8");
}

function authenticate(entry: PendingWorkerConnection, text: string): boolean {
	return verifyWorkerConnectToken(text, entry.tokenHash);
}

export function createWorkerWebSocketIpcManager(
	options: { authTimeoutMs?: number; maxBufferedMessages?: number } = {},
) {
	const pending = new Map<string, PendingWorkerConnection>();
	const authTimeoutMs = options.authTimeoutMs ?? 5_000;
	const maxBufferedMessages = options.maxBufferedMessages ?? 1_000;
	let retryUnknownWorkerConnections = false;

	function reportRuntimeError(entry: PendingWorkerConnection, error: unknown): void {
		entry.callbacks.onRuntimeError(error);
	}

	function clearAuthTimer(entry: PendingWorkerConnection): void {
		if (entry.authTimer) {
			clearTimeout(entry.authTimer);
			entry.authTimer = null;
		}
	}

	function closeSocket(
		entry: PendingWorkerConnection,
		socket: WorkerWebSocketLike,
		code: number,
		reason: string,
	): void {
		if (entry.socket === socket) {
			clearAuthTimer(entry);
			entry.socket = null;
			entry.socketAuthenticated = false;
		}
		try {
			socket.close(code, reason);
		} catch (error) {
			reportRuntimeError(entry, error);
		}
	}

	function sendNow(
		entry: PendingWorkerConnection,
		socket: WorkerWebSocketLike,
		data: string,
	): boolean {
		if (socket.readyState !== 1) {
			return false;
		}
		try {
			socket.send(data);
			return true;
		} catch (error) {
			reportRuntimeError(entry, error);
			closeSocket(entry, socket, 1011, "worker websocket send failed");
			return false;
		}
	}

	function flushOutbound(entry: PendingWorkerConnection, socket: WorkerWebSocketLike): void {
		while (entry.outbound.length > 0) {
			const data = entry.outbound[0];
			if (!sendNow(entry, socket, data)) {
				return;
			}
			entry.outbound.shift();
		}
	}

	function putEntry(input: {
		instanceId: string;
		workerId: string;
		callbacks: WorkerWebSocketCallbacks;
		tokenHash: string;
	}): void {
		pending.set(connectionKey(input.instanceId, input.workerId), {
			instanceId: input.instanceId,
			workerId: input.workerId,
			tokenHash: input.tokenHash,
			callbacks: input.callbacks,
			socket: null,
			socketAuthenticated: false,
			authTimer: null,
			outbound: [],
		});
	}

	return {
		setUnknownWorkerConnectionsRetryable(enabled: boolean): void {
			retryUnknownWorkerConnections = enabled;
		},
		verifyWorkerToken({
			instanceId,
			workerId,
			token,
		}: {
			instanceId: string;
			workerId: string;
			token: string;
		}) {
			const entry = pending.get(connectionKey(instanceId, workerId));
			return entry ? verifyWorkerConnectToken(token, entry.tokenHash) : false;
		},
		registerWorker({
			instanceId,
			workerId,
			callbacks,
			tokenHash,
		}: {
			instanceId: string;
			workerId: string;
			callbacks: WorkerWebSocketCallbacks;
			tokenHash: string;
		}) {
			putEntry({
				instanceId,
				workerId,
				callbacks,
				tokenHash,
			});
		},
		bindSocket({
			instanceId,
			workerId,
			socket,
		}: {
			instanceId: string;
			workerId: string;
			socket: WorkerWebSocketLike;
		}): { ok: true } | { ok: false; error: string; code: number } {
			const key = connectionKey(instanceId, workerId);
			const entry = pending.get(key);
			if (!entry) {
				return retryUnknownWorkerConnections
					? { ok: false, error: "unknown worker connection; retry adoption", code: 1013 }
					: { ok: false, error: "unknown worker connection", code: 1008 };
			}
			if (entry.socket) {
				if (entry.socketAuthenticated) {
					return { ok: false, error: "worker connection already bound", code: 1008 };
				}
				closeSocket(entry, entry.socket, 1008, "worker connection authentication timed out");
			}

			entry.socket = socket;
			entry.socketAuthenticated = false;
			entry.authTimer = setTimeout(() => {
				if (entry.socket === socket && !entry.socketAuthenticated) {
					closeSocket(entry, socket, 1008, "worker connection authentication timed out");
				}
			}, authTimeoutMs);
			const rejectAuth = (reason: string) => closeSocket(entry, socket, 1008, reason);
			const deliverIpcText = (text: string) => {
				const parsed = deserializeMessage(text);
				if (!parsed.ok) {
					entry.callbacks.onInvalidOutput();
					closeSocket(entry, socket, 1003, parsed.error);
					return;
				}
				try {
					entry.callbacks.onEnvelope(parsed.message);
				} catch (error) {
					reportRuntimeError(entry, error);
					closeSocket(entry, socket, 1011, "worker IPC delivery failed");
				}
			};

			socket.on("message", (raw) => {
				if (entry.socket !== socket) {
					return;
				}
				const text = rawToText(raw);
				if (entry.socketAuthenticated) {
					deliverIpcText(text);
					return;
				}
				if (!authenticate(entry, text)) {
					rejectAuth("invalid worker connection token");
					return;
				}
				clearAuthTimer(entry);
				entry.socketAuthenticated = true;
				flushOutbound(entry, socket);
			});
			socket.on("error", (error) => {
				if (entry.socket === socket && entry.socketAuthenticated) {
					reportRuntimeError(entry, error);
				}
			});
			socket.on("close", () => {
				if (entry.socket !== socket) {
					return;
				}
				clearAuthTimer(entry);
				entry.socket = null;
				entry.socketAuthenticated = false;
			});

			return { ok: true };
		},
		send(instanceId: string, workerId: string, message: ServerToWorkerMessage) {
			const entry = pending.get(connectionKey(instanceId, workerId));
			if (!entry) {
				return;
			}
			const data = serializeMessage(message);
			if (!entry.socket || !entry.socketAuthenticated) {
				if (entry.outbound.length >= maxBufferedMessages) {
					entry.outbound = [];
					reportRuntimeError(
						entry,
						new WorkerOutboundBufferOverflowError(instanceId, workerId, maxBufferedMessages),
					);
					if (entry.socket) {
						closeSocket(entry, entry.socket, 1011, "worker websocket outbound buffer overflow");
					}
					return;
				}
				entry.outbound.push(data);
				return;
			}
			sendNow(entry, entry.socket, data);
		},
		unregister(instanceId: string, workerId: string, reason: string) {
			const key = connectionKey(instanceId, workerId);
			const entry = pending.get(key);
			pending.delete(key);
			if (!entry) {
				return;
			}
			const socket = entry.socket;
			entry.socket = null;
			entry.socketAuthenticated = false;
			entry.outbound = [];
			try {
				socket?.close(1000, reason);
			} catch {
				// Ignore cleanup close failures after the worker runtime has already ended.
			}
		},
	};
}

export type WorkerWebSocketIpcManager = ReturnType<typeof createWorkerWebSocketIpcManager>;
