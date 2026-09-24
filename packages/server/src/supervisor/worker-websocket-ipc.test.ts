import { EventEmitter } from "node:events";
import { createIpcMessage, serializeMessage } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it } from "vitest";
import { hashWorkerConnectToken } from "./worker-connect-token.js";
import {
	createWorkerWebSocketIpcManager,
	WorkerOutboundBufferOverflowError,
	type WorkerWebSocketLike,
} from "./worker-websocket-ipc.js";

class FakeSocket extends EventEmitter implements WorkerWebSocketLike {
	readyState = 1;
	sent: string[] = [];
	closeCalls: Array<{ code?: number; reason?: string }> = [];
	throwOnSend = false;

	send(data: string): void {
		if (this.throwOnSend) {
			throw new Error("send failed");
		}
		this.sent.push(data);
	}

	close(code?: number, reason?: string): void {
		this.closeCalls.push({ code, reason });
		this.readyState = 3;
		this.emit("close");
	}
}

function heartbeat(workerId = "wkr_1") {
	return createIpcMessage({
		type: "worker.heartbeat",
		instanceId: "proc_1",
		workerId,
		messageId: `hb-${workerId}`,
		payload: {
			state: "idle",
			lastSequenceConsumed: 0,
			currentSelectedTurnId: "generate_plan",
		},
	});
}

function stop(messageId = "stop-1") {
	return createIpcMessage({
		type: "worker.stop",
		instanceId: "proc_1",
		workerId: "wkr_1",
		messageId,
		payload: { reason: "test" },
	});
}

function createRegistration(
	input: { onEnvelope?: (envelope: unknown) => void; token?: string } = {},
) {
	const manager = createWorkerWebSocketIpcManager();
	const envelopes: unknown[] = [];
	const runtimeErrors: unknown[] = [];
	let invalidOutputCount = 0;
	const token = input.token ?? "persistent-token";
	manager.registerWorker({
		instanceId: "proc_1",
		workerId: "wkr_1",
		tokenHash: hashWorkerConnectToken(token),
		callbacks: {
			onEnvelope: input.onEnvelope ?? ((envelope) => envelopes.push(envelope)),
			onInvalidOutput: () => invalidOutputCount++,
			onRuntimeError: (error) => runtimeErrors.push(error),
		},
	});
	return {
		manager,
		token,
		envelopes,
		runtimeErrors,
		get invalidOutputCount() {
			return invalidOutputCount;
		},
	};
}

function bindAndAuthenticate(
	manager: ReturnType<typeof createWorkerWebSocketIpcManager>,
	token: string,
): FakeSocket {
	const socket = new FakeSocket();
	expect(manager.bindSocket({ instanceId: "proc_1", workerId: "wkr_1", socket }).ok).toBe(true);
	socket.emit("message", token);
	return socket;
}

describe("createWorkerWebSocketIpcManager", () => {
	it("binds a token-authenticated socket and routes worker envelopes", () => {
		const registration = createRegistration();
		const socket = bindAndAuthenticate(registration.manager, registration.token);

		socket.emit("message", serializeMessage(heartbeat()));

		expect(registration.envelopes).toEqual([
			expect.objectContaining({ type: "worker.heartbeat", messageId: "hb-wkr_1" }),
		]);
	});

	it("reports outbound buffer overflow instead of dropping queued server messages", () => {
		const manager = createWorkerWebSocketIpcManager({ maxBufferedMessages: 2 });
		const runtimeErrors: unknown[] = [];
		manager.registerWorker({
			instanceId: "proc_1",
			workerId: "wkr_1",
			tokenHash: hashWorkerConnectToken("persistent-token"),
			callbacks: {
				onEnvelope: () => {},
				onInvalidOutput: () => {},
				onRuntimeError: (error) => runtimeErrors.push(error),
			},
		});
		manager.send("proc_1", "wkr_1", stop("stop-1"));
		manager.send("proc_1", "wkr_1", stop("stop-2"));
		manager.send("proc_1", "wkr_1", stop("stop-3"));
		const socket = bindAndAuthenticate(manager, "persistent-token");

		expect(runtimeErrors).toEqual([expect.any(WorkerOutboundBufferOverflowError)]);
		expect(socket.sent).toEqual([]);
	});

	it("queues server messages until the worker socket authenticates", () => {
		const { manager, token } = createRegistration();
		const messages = [stop("stop-1"), stop("stop-2")] as const;
		manager.send("proc_1", "wkr_1", messages[0]);
		const socket = new FakeSocket();

		manager.bindSocket({ instanceId: "proc_1", workerId: "wkr_1", socket });
		manager.send("proc_1", "wkr_1", messages[1]);
		expect(socket.sent).toEqual([]);
		socket.emit("message", token);

		expect(socket.sent.map((message) => JSON.parse(message))).toEqual(messages);
	});

	it("rejects unknown worker connections outside the startup adoption window", () => {
		const manager = createWorkerWebSocketIpcManager();
		const socket = new FakeSocket();

		expect(manager.bindSocket({ instanceId: "proc_1", workerId: "wkr_1", socket })).toEqual({
			ok: false,
			error: "unknown worker connection",
			code: 1008,
		});
	});

	it("asks unknown worker connections to retry during startup adoption", () => {
		const manager = createWorkerWebSocketIpcManager();
		manager.setUnknownWorkerConnectionsRetryable(true);
		const socket = new FakeSocket();

		expect(manager.bindSocket({ instanceId: "proc_1", workerId: "wkr_1", socket })).toEqual({
			ok: false,
			error: "unknown worker connection; retry adoption",
			code: 1013,
		});
	});

	it("rejects bad auth without consuming the token or reporting worker runtime failure", () => {
		const { manager, token, runtimeErrors } = createRegistration();
		const rejected = new FakeSocket();
		manager.bindSocket({ instanceId: "proc_1", workerId: "wkr_1", socket: rejected });

		rejected.emit("message", "wrong-token");
		const accepted = bindAndAuthenticate(manager, token);
		manager.send("proc_1", "wkr_1", stop());

		expect(rejected.closeCalls.at(-1)).toMatchObject({ code: 1008 });
		expect(accepted.sent).toHaveLength(1);
		expect(runtimeErrors).toEqual([]);
	});

	it("does not let an idle unauthenticated socket block a legitimate worker", () => {
		const { manager, token, runtimeErrors } = createRegistration();
		const idle = new FakeSocket();
		expect(manager.bindSocket({ instanceId: "proc_1", workerId: "wkr_1", socket: idle }).ok).toBe(
			true,
		);

		const accepted = bindAndAuthenticate(manager, token);
		manager.send("proc_1", "wkr_1", stop());

		expect(idle.closeCalls.at(-1)).toMatchObject({ code: 1008 });
		expect(accepted.sent).toHaveLength(1);
		expect(runtimeErrors).toEqual([]);
	});

	it("closes idle unauthenticated sockets after the auth timeout", async () => {
		const manager = createWorkerWebSocketIpcManager({ authTimeoutMs: 1 });
		manager.registerWorker({
			instanceId: "proc_1",
			workerId: "wkr_1",
			tokenHash: hashWorkerConnectToken("persistent-token"),
			callbacks: {
				onEnvelope: () => {},
				onInvalidOutput: () => {},
				onRuntimeError: () => {},
			},
		});
		const idle = new FakeSocket();
		expect(manager.bindSocket({ instanceId: "proc_1", workerId: "wkr_1", socket: idle }).ok).toBe(
			true,
		);

		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(idle.closeCalls.at(-1)).toMatchObject({
			code: 1008,
			reason: "worker connection authentication timed out",
		});
	});

	it("keeps hashed worker tokens usable for internal HTTP auth", () => {
		const { manager, token, runtimeErrors } = createRegistration();
		expect(manager.verifyWorkerToken({ instanceId: "proc_1", workerId: "wkr_1", token })).toBe(
			true,
		);
		const first = bindAndAuthenticate(manager, token);
		const second = new FakeSocket();

		expect(manager.verifyWorkerToken({ instanceId: "proc_1", workerId: "wkr_1", token })).toBe(
			true,
		);
		expect(manager.bindSocket({ instanceId: "proc_1", workerId: "wkr_1", socket: second })).toEqual(
			expect.objectContaining({ ok: false }),
		);
		manager.send("proc_1", "wkr_1", stop());

		expect(first.sent).toHaveLength(1);
		expect(second.sent).toEqual([]);
		expect(runtimeErrors).toEqual([]);
	});

	it("rejects a separate snapshot token as websocket auth", () => {
		const { manager, token } = createRegistration();
		const socket = new FakeSocket();
		expect(token).not.toBe("snapshot-token");
		manager.bindSocket({ instanceId: "proc_1", workerId: "wkr_1", socket });

		socket.emit("message", "snapshot-token");

		expect(socket.closeCalls.at(-1)).toMatchObject({
			code: 1008,
			reason: "invalid worker connection token",
		});
	});

	it("rejects invalid IPC text after auth", () => {
		const registration = createRegistration();
		const socket = bindAndAuthenticate(registration.manager, registration.token);

		socket.emit("message", "not json");

		expect(registration.invalidOutputCount).toBe(1);
		expect(socket.closeCalls.at(-1)).toMatchObject({ code: 1003 });
	});

	it("reports envelope delivery failures as runtime errors", () => {
		const registration = createRegistration({
			onEnvelope: () => {
				throw new Error("delivery failed");
			},
		});
		const socket = bindAndAuthenticate(registration.manager, registration.token);

		socket.emit("message", serializeMessage(heartbeat()));

		expect(registration.runtimeErrors).toEqual([
			expect.objectContaining({ message: "delivery failed" }),
		]);
		expect(socket.closeCalls.at(-1)).toMatchObject({ code: 1011 });
	});

	it("reports send failures and replays the unsent message after reconnect", () => {
		const registration = createRegistration();
		const socket = bindAndAuthenticate(registration.manager, registration.token);
		socket.throwOnSend = true;

		const message = stop();
		registration.manager.send("proc_1", "wkr_1", message);

		expect(registration.runtimeErrors).toEqual([
			expect.objectContaining({ message: "send failed" }),
		]);
		expect(socket.closeCalls.at(-1)).toMatchObject({ code: 1011 });
		const replacement = bindAndAuthenticate(registration.manager, registration.token);
		expect(replacement.sent.map((sent) => JSON.parse(sent))).toEqual([message]);
	});

	it("queues a message when an authenticated socket stops being writable", () => {
		const registration = createRegistration();
		const socket = bindAndAuthenticate(registration.manager, registration.token);
		socket.readyState = 2;

		const message = stop();
		registration.manager.send("proc_1", "wkr_1", message);

		expect(socket.sent).toEqual([]);
		expect(socket.closeCalls.at(-1)).toMatchObject({
			code: 1011,
			reason: "worker websocket unavailable during send",
		});
		const replacement = bindAndAuthenticate(registration.manager, registration.token);
		expect(replacement.sent.map((sent) => JSON.parse(sent))).toEqual([message]);
	});

	it("allows workers to rebind with a hashed token and buffers while disconnected", () => {
		const registration = createRegistration({ token: "persistent-token" });
		const first = bindAndAuthenticate(registration.manager, registration.token);
		const beforeClose = stop("stop-before-close");
		const disconnected = stop("stop-while-disconnected");
		const beforeAuth = stop("stop-before-auth");
		registration.manager.send("proc_1", "wkr_1", beforeClose);
		first.emit("close");
		registration.manager.send("proc_1", "wkr_1", disconnected);

		const second = new FakeSocket();
		expect(
			registration.manager.bindSocket({ instanceId: "proc_1", workerId: "wkr_1", socket: second })
				.ok,
		).toBe(true);
		registration.manager.send("proc_1", "wkr_1", beforeAuth);
		expect(second.sent).toEqual([]);
		second.emit("message", registration.token);
		second.emit("message", serializeMessage(heartbeat()));

		expect(first.sent.map((sent) => JSON.parse(sent))).toEqual([beforeClose]);
		expect(second.sent.map((sent) => JSON.parse(sent))).toEqual([disconnected, beforeAuth]);
		expect(registration.envelopes).toEqual([expect.objectContaining({ type: "worker.heartbeat" })]);
		expect(registration.runtimeErrors).toEqual([]);
	});
});
