import websocket from "@fastify/websocket";
import { createEphemeralWsFrame, WS_PROTOCOL_VERSION } from "@leitwerk-dev/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthService } from "../auth/auth-service.js";
import { authenticateRequest } from "../auth/fastify-auth.js";
import type { WorkerWebSocketIpcManager } from "../supervisor/worker-websocket-ipc.js";
import type { Broadcaster } from "../ws/broadcast.js";

// How often the server pings each browser client. A miss between two ticks
// terminates the socket so dead clients are reaped from the broadcaster and
// idle proxies don't silently drop the connection.
const SERVER_HEARTBEAT_INTERVAL_MS = 30_000;

// Structural view of the underlying `ws` socket so we can drive protocol-level
// liveness without depending on the `ws` type declarations.
interface LivenessSocket {
	isAlive?: boolean;
	readyState: number;
	ping(): void;
	terminate(): void;
	on(event: string, handler: (...args: unknown[]) => void): void;
}

export interface RegisterWebsocketOptions {
	// Overridable so tests can drive the heartbeat without long waits.
	heartbeatIntervalMs?: number;
}

function authenticateClientWebSocket(
	auth: AuthService,
	request: FastifyRequest,
	reply: FastifyReply,
): void {
	const actor = authenticateRequest(auth, request);
	if (!actor && auth.config.enabled) {
		reply.code(401).send({ error: "Authentication required" });
		return;
	}
	if (actor) {
		request.actor = actor;
	}
	if (!auth.config.enabled) {
		return;
	}
	const origin = request.headers.origin;
	if (typeof origin !== "string" || origin !== auth.config.appBaseOrigin) {
		reply.code(403).send({ error: "WebSocket origin is not allowed" });
	}
}

export async function registerWebsocket(
	app: FastifyInstance,
	broadcaster: Broadcaster,
	workerIpc: WorkerWebSocketIpcManager,
	authService?: AuthService,
	options: RegisterWebsocketOptions = {},
): Promise<void> {
	await app.register(websocket);

	const heartbeatIntervalMs = options.heartbeatIntervalMs ?? SERVER_HEARTBEAT_INTERVAL_MS;

	// Track browser clients (the /ws route) so the heartbeat only targets them
	// and leaves worker IPC sockets untouched.
	const liveClients = new Set<LivenessSocket>();
	const heartbeat = setInterval(() => {
		for (const client of liveClients) {
			if (client.isAlive === false) {
				liveClients.delete(client);
				client.terminate();
				continue;
			}
			client.isAlive = false;
			try {
				client.ping();
			} catch {
				liveClients.delete(client);
				client.terminate();
			}
		}
	}, heartbeatIntervalMs);
	// Don't keep the event loop alive purely for the heartbeat timer.
	if (typeof heartbeat.unref === "function") {
		heartbeat.unref();
	}
	app.addHook("onClose", async () => {
		clearInterval(heartbeat);
		liveClients.clear();
	});

	app.get<{ Querystring: { instanceId?: string; workerId?: string } }>(
		"/internal/workers/connect",
		{ websocket: true },
		(socket, request) => {
			const { instanceId, workerId } = request.query;
			if (!instanceId || !workerId) {
				socket.close(1008, "invalid worker connection request");
				return;
			}
			const bound = workerIpc.bindSocket({ instanceId, workerId, socket });
			if (!bound.ok) {
				socket.close(bound.code, bound.error);
			}
		},
	);

	app.get(
		"/ws",
		{
			websocket: true,
			preValidation: authService
				? async (request, reply) => authenticateClientWebSocket(authService, request, reply)
				: undefined,
		},
		(socket) => {
			broadcaster.addClient(socket);

			// Register for the server-side heartbeat and mark alive on the
			// underlying ws protocol pong (distinct from the app-level {type:pong}
			// frame the client also receives).
			const liveSocket = socket as unknown as LivenessSocket;
			liveSocket.isAlive = true;
			liveClients.add(liveSocket);
			liveSocket.on("pong", () => {
				liveSocket.isAlive = true;
			});
			liveSocket.on("close", () => {
				liveClients.delete(liveSocket);
			});

			socket.send(
				JSON.stringify(
					createEphemeralWsFrame({
						type: "hello",
						payload: { serverVersion: "0.1.0" },
					}),
				),
			);

			socket.on("message", (raw: Buffer) => {
				// Any inbound app frame also proves the socket is alive.
				liveSocket.isAlive = true;
				try {
					const msg = JSON.parse(String(raw));
					if (msg.type === "ping") {
						socket.send(
							JSON.stringify(
								createEphemeralWsFrame({
									type: "pong",
									payload: {},
								}),
							),
						);
					}
				} catch {
					// ignore malformed frames
				}
			});
		},
	);
}

export function healthBody() {
	return { status: "ok", protocol: WS_PROTOCOL_VERSION };
}
