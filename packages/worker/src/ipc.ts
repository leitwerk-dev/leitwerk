import {
	decodeServerToWorkerMessage,
	deserializeMessage,
	type ServerToWorkerMessage,
	serializeMessage,
	WORKER_IPC_CONNECT_TOKEN_ENV,
	WORKER_IPC_RECONNECT_ENV,
	WORKER_IPC_SERVER_URL_ENV,
	type WorkerToServerMessage,
} from "@leitwerk-dev/worker-protocol";

export interface WorkerIpc {
	send(message: WorkerToServerMessage): void;
	onMessage(handler: (message: ServerToWorkerMessage) => void): void;
	onError(handler: (error: Error) => void): void;
	onConnect?(handler: () => void): void;
	start(): void;
	stop(): void;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

interface WebSocketMessageEventLike {
	data: string | ArrayBuffer | Buffer;
}

interface WebSocketLike {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(event: "open", handler: () => void): void;
	addEventListener(event: "message", handler: (event: WebSocketMessageEventLike) => void): void;
	addEventListener(event: "error", handler: (event: unknown) => void): void;
	addEventListener(
		event: "close",
		handler: (event?: { code?: number; reason?: string }) => void,
	): void;
}

type WebSocketCtor = new (url: string) => WebSocketLike;

function toWebSocketUrl(input: {
	serverUrl: string;
	instanceId: string;
	workerId: string;
}): string {
	const url = new URL("/internal/workers/connect", input.serverUrl);
	if (url.protocol === "https:") {
		url.protocol = "wss:";
	} else if (url.protocol === "http:") {
		url.protocol = "ws:";
	} else if (url.protocol !== "wss:" && url.protocol !== "ws:") {
		throw new Error("Worker WebSocket IPC requires an http(s) or ws(s) server URL");
	}
	url.searchParams.set("instanceId", input.instanceId);
	url.searchParams.set("workerId", input.workerId);
	return url.toString();
}

function webSocketDataToText(data: WebSocketMessageEventLike["data"]): string {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString("utf8");
	}
	return data.toString("utf8");
}

export function createWebSocketWorkerIpc(input: {
	serverUrl: string;
	instanceId: string;
	workerId: string;
	token: string;
	reconnect?: boolean;
}): WorkerIpc {
	let messageHandler: ((message: ServerToWorkerMessage) => void) | undefined;
	let errorHandler: ((error: Error) => void) | undefined;
	let connectHandler: (() => void) | undefined;
	let socket: WebSocketLike | null = null;
	let started = false;
	let stopping = false;
	let reconnectAttempt = 0;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let openedOnce = false;
	const outbound: string[] = [];

	const reconnectEnabled = input.reconnect === true;
	const emitError = (error: unknown) => errorHandler?.(toError(error));
	const clearReconnectTimer = () => {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	};
	const sendText = (text: string): boolean => {
		if (!socket || socket.readyState !== 1) {
			return false;
		}
		try {
			socket.send(text);
			return true;
		} catch (error) {
			if (!reconnectEnabled) {
				emitError(error);
			}
			return false;
		}
	};
	const flushOutbound = () => {
		if (!sendText(input.token)) {
			return;
		}
		if (openedOnce) {
			connectHandler?.();
		}
		openedOnce = true;
		for (let next = outbound.shift(); next; next = outbound.shift()) {
			if (!sendText(next)) {
				outbound.unshift(next);
				break;
			}
		}
	};
	const deliverText = (text: string) => {
		const parsed = deserializeMessage(text);
		if (!parsed.ok) {
			emitError(new Error(parsed.error));
			return;
		}
		const decoded = decodeServerToWorkerMessage(parsed.message);
		if (!decoded.ok) {
			emitError(new Error(decoded.error));
			return;
		}
		messageHandler?.(decoded.message);
	};
	const scheduleReconnect = (connect: () => void) => {
		if (!started || stopping || !reconnectEnabled || reconnectTimer) {
			return;
		}
		const delayMs = Math.min(5_000, 100 * 2 ** Math.min(reconnectAttempt, 6));
		reconnectAttempt += 1;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, delayMs);
		reconnectTimer.unref?.();
	};

	return {
		send(message) {
			const line = serializeMessage(message);
			if (!socket || socket.readyState !== 1) {
				outbound.push(line);
				return;
			}
			if (!sendText(line)) {
				outbound.unshift(line);
			}
		},
		onMessage(handler) {
			messageHandler = handler;
		},
		onError(handler) {
			errorHandler = handler;
		},
		onConnect(handler) {
			connectHandler = handler;
		},
		start() {
			if (started) {
				return;
			}
			const WebSocketImpl = (globalThis as unknown as { WebSocket?: WebSocketCtor }).WebSocket;
			if (!WebSocketImpl) {
				throw new Error("WebSocket IPC requested, but no WebSocket implementation is available");
			}
			started = true;
			stopping = false;
			const connect = () => {
				if (!started || stopping) {
					return;
				}
				socket = new WebSocketImpl(toWebSocketUrl(input));
				socket.addEventListener("open", () => {
					reconnectAttempt = 0;
					flushOutbound();
				});
				socket.addEventListener("message", (event) => deliverText(webSocketDataToText(event.data)));
				socket.addEventListener("error", (event) => {
					if (!stopping && !reconnectEnabled) {
						emitError(event instanceof Error ? event : new Error("Worker WebSocket error"));
					}
				});
				socket.addEventListener("close", (event) => {
					if (stopping) {
						return;
					}
					socket = null;
					if (reconnectEnabled && event?.code !== 1008) {
						scheduleReconnect(connect);
						return;
					}
					emitError(
						new Error(
							event?.reason
								? `Worker WebSocket connection closed: ${event.reason}`
								: "Worker WebSocket connection closed",
						),
					);
				});
			};
			connect();
		},
		stop() {
			if (!started) {
				return;
			}
			started = false;
			stopping = true;
			clearReconnectTimer();
			socket?.close(1000, "worker ipc stopped");
			socket = null;
			outbound.length = 0;
		},
	};
}

export function createWorkerIpcFromEnvironment(input: {
	env?: NodeJS.ProcessEnv;
	instanceId: string;
	workerId: string;
}): WorkerIpc {
	const env = input.env ?? process.env;
	const serverUrl = env[WORKER_IPC_SERVER_URL_ENV];
	const token = env[WORKER_IPC_CONNECT_TOKEN_ENV];
	if (!serverUrl || !token) {
		throw new Error("WebSocket worker IPC requires LEITWERK_SERVER_URL and worker token env");
	}
	return createWebSocketWorkerIpc({
		serverUrl,
		instanceId: input.instanceId,
		workerId: input.workerId,
		token,
		reconnect: env[WORKER_IPC_RECONNECT_ENV] === "1",
	});
}
