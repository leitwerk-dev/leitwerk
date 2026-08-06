// @vitest-environment jsdom
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiRuntimeTransportConfig, UiWebSocketLike } from "./runtime-config.js";

const CONFIG_KEY = Symbol.for("leitwerk.uiRuntimeTransportConfig");

type GlobalWithConfig = typeof globalThis & {
	[CONFIG_KEY]?: UiRuntimeTransportConfig;
};

// Minimal scriptable WebSocket stand-in driven by the injected webSocketCtor.
class FakeWebSocket implements UiWebSocketLike {
	static instances: FakeWebSocket[] = [];

	readyState = 0;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
	onclose: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	sent: string[] = [];
	closed = false;

	constructor(public url: string) {
		FakeWebSocket.instances.push(this);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.readyState = 3;
		this.onclose?.(new Event("close"));
	}

	// Test helpers
	open(): void {
		this.readyState = 1;
		this.onopen?.(new Event("open"));
	}

	emit(data: unknown): void {
		this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<unknown>);
	}

	get pings(): string[] {
		return this.sent.filter((raw) => {
			try {
				return JSON.parse(raw).type === "ping";
			} catch {
				return false;
			}
		});
	}
}

function setConfig(config: UiRuntimeTransportConfig): void {
	(globalThis as GlobalWithConfig)[CONFIG_KEY] = config;
}

function clearConfig(): void {
	delete (globalThis as GlobalWithConfig)[CONFIG_KEY];
}

const HEARTBEAT_INTERVAL_MS = 1_000;
const HEARTBEAT_TIMEOUT_MS = 500;
const RECONNECT_DELAY_MS = 200;

async function importWsModule() {
	// Fresh module per test so the module-level socket/timers reset.
	vi.resetModules();
	return await import("./ws.svelte.js");
}

describe("ws heartbeat and recovery", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakeWebSocket.instances = [];
		setConfig({
			wsUrl: "ws://test.local/ws",
			webSocketCtor: FakeWebSocket,
			reconnectDelayMs: RECONNECT_DELAY_MS,
			heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
			heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		clearConfig();
	});

	it("sends pings on the heartbeat interval once connected", async () => {
		const ws = await importWsModule();
		ws.connect();
		const socket = FakeWebSocket.instances[0];
		socket.open();

		expect(socket.pings).toHaveLength(0);
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
		expect(socket.pings).toHaveLength(1);
		// An inbound pong before the next tick keeps the connection alive.
		socket.emit({ protocol: 1, type: "pong", durability: "ephemeral", payload: {} });
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
		expect(socket.pings).toHaveLength(2);
		expect(socket.closed).toBe(false);

		ws.disconnect();
	});

	it("force-closes and reconnects when no message arrives within the timeout", async () => {
		const ws = await importWsModule();
		ws.connect();
		const socket = FakeWebSocket.instances[0];
		socket.open();

		// First ping, then no inbound frame within the timeout window.
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
		expect(socket.pings).toHaveLength(1);
		expect(socket.closed).toBe(false);

		vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS);
		expect(socket.closed).toBe(true);
		expect(get(ws.wsStore).status).toBe("disconnected");

		// onclose schedules a reconnect after the configured delay.
		vi.advanceTimersByTime(RECONNECT_DELAY_MS);
		expect(FakeWebSocket.instances).toHaveLength(2);

		ws.disconnect();
	});

	it("resets the watchdog when an inbound pong arrives", async () => {
		const ws = await importWsModule();
		ws.connect();
		const socket = FakeWebSocket.instances[0];
		socket.open();

		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
		expect(socket.pings).toHaveLength(1);

		// Pong arrives just before the watchdog would fire.
		vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS - 1);
		socket.emit({ protocol: 1, type: "pong", durability: "ephemeral", payload: {} });
		// Advancing past the original timeout no longer closes the socket.
		vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS);
		expect(socket.closed).toBe(false);

		ws.disconnect();
	});

	it("increments reconnectCount after a forced reconnect so pages reload", async () => {
		const ws = await importWsModule();
		ws.connect();
		const first = FakeWebSocket.instances[0];
		first.open();
		expect(get(ws.wsStore).reconnectCount).toBe(0);

		// Drive a dead-connection detection.
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS);
		expect(first.closed).toBe(true);
		vi.advanceTimersByTime(RECONNECT_DELAY_MS);

		const second = FakeWebSocket.instances[1];
		second.open();
		expect(get(ws.wsStore).reconnectCount).toBe(1);

		ws.disconnect();
	});

	it("forces a reconnect when the tab becomes visible and the socket is dead", async () => {
		const ws = await importWsModule();
		ws.connect();
		const socket = FakeWebSocket.instances[0];
		socket.open();

		// Simulate a silently half-open socket: still readyState OPEN but the
		// server is gone. We mark it dead by closing the underlying readyState
		// without firing onclose, mimicking a stale connection.
		socket.readyState = 3;

		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => "visible",
		});
		document.dispatchEvent(new Event("visibilitychange"));

		// A fresh socket is created to reload state.
		expect(FakeWebSocket.instances).toHaveLength(2);

		ws.disconnect();
	});

	it("pings an open socket on focus to probe liveness", async () => {
		const ws = await importWsModule();
		ws.connect();
		const socket = FakeWebSocket.instances[0];
		socket.open();

		window.dispatchEvent(new Event("focus"));
		expect(socket.pings).toHaveLength(1);

		ws.disconnect();
	});

	it("forces a reconnect when the network comes back online and the socket is dead", async () => {
		const ws = await importWsModule();
		ws.connect();
		const socket = FakeWebSocket.instances[0];
		socket.open();
		socket.readyState = 3;

		window.dispatchEvent(new Event("online"));
		expect(FakeWebSocket.instances).toHaveLength(2);

		ws.disconnect();
	});

	it("ignores a late onclose from a stale socket after recovery replaces it", async () => {
		const ws = await importWsModule();
		ws.connect();
		const first = FakeWebSocket.instances[0];
		first.open();
		// Capture the original onclose closure before recovery detaches it so we
		// can fire a delayed callback the way the real socket would.
		const staleOnClose = first.onclose;

		// Silently half-open: still looks closing/closed to readyState checks but
		// the real onclose has not fired yet.
		first.readyState = 3;

		// Recovery creates a fresh socket while the old one's callback survives.
		window.dispatchEvent(new Event("online"));
		expect(FakeWebSocket.instances).toHaveLength(2);
		const second = FakeWebSocket.instances[1];
		second.open();
		expect(get(ws.wsStore).status).toBe("connected");

		// The stale socket's delayed onclose must not tear down the live one.
		staleOnClose?.(new Event("close"));
		expect(get(ws.wsStore).status).toBe("connected");

		// No spurious reconnect should be scheduled by the stale callback.
		vi.advanceTimersByTime(RECONNECT_DELAY_MS);
		expect(FakeWebSocket.instances).toHaveLength(2);

		ws.disconnect();
	});

	it("stops the heartbeat and removes listeners on disconnect", async () => {
		const ws = await importWsModule();
		ws.connect();
		const socket = FakeWebSocket.instances[0];
		socket.open();
		ws.disconnect();

		// No further pings after disconnect.
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
		expect(socket.pings).toHaveLength(0);

		// Recovery triggers no longer create new sockets.
		window.dispatchEvent(new Event("focus"));
		window.dispatchEvent(new Event("online"));
		expect(FakeWebSocket.instances).toHaveLength(1);
	});
});
