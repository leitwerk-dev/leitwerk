import {
	type PrimaryPathWsFrame,
	parsePrimaryPathWsFrameInput,
	parseWsFrame,
	WS_PRIMARY_PATH_TYPES,
	type WsFrame,
} from "@leitwerk-dev/protocol";
import { derived, writable } from "svelte/store";
import {
	getHeartbeatIntervalMs,
	getHeartbeatTimeoutMs,
	getReconnectDelayMs,
	getWebSocketCtor,
	resolveWsUrl,
	type UiWebSocketLike,
} from "./runtime-config";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

const wsState = writable({
	status: "disconnected" as ConnectionStatus,
	serverVersion: null as string | null,
	reconnectCount: 0,
});

export const wsStore = derived(wsState, (value) => value);

const PRIMARY_PATH_FRAME_TYPES = new Set(
	Object.values(WS_PRIMARY_PATH_TYPES) as PrimaryPathWsFrame["type"][],
);

function parseIncomingWsFrame(value: unknown): WsFrame | null {
	const frame = parseWsFrame(value);
	if (!frame.ok) {
		return null;
	}
	if (!PRIMARY_PATH_FRAME_TYPES.has(frame.value.type as PrimaryPathWsFrame["type"])) {
		return frame.value;
	}
	const primaryPathFrame = parsePrimaryPathWsFrameInput(value);
	return primaryPathFrame.ok ? primaryPathFrame.value : null;
}

let eventHandler: ((frame: WsFrame) => void) | null = null;
let socket: UiWebSocketLike | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
let hasConnectedBefore = false;
let shouldReconnect = true;
let recoveryListenersAttached = false;

export function onWsEvent(handler: (frame: WsFrame) => void) {
	eventHandler = handler;
}

function clearHeartbeatTimers() {
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
	if (watchdogTimer) {
		clearTimeout(watchdogTimer);
		watchdogTimer = null;
	}
}

// Drop a (closing/closed) socket's handlers so its late onclose/onerror/
// onmessage callbacks can't mutate module state for a connection we're about
// to replace it with.
function detachSocketHandlers(target: UiWebSocketLike) {
	target.onopen = null;
	target.onmessage = null;
	target.onclose = null;
	target.onerror = null;
}

// Any inbound frame (data, hello, or pong) proves the socket is still alive,
// so disarm the watchdog that was waiting for a response to our last ping.
function noteInboundMessage() {
	if (watchdogTimer) {
		clearTimeout(watchdogTimer);
		watchdogTimer = null;
	}
}

function sendPing() {
	if (!socket || socket.readyState !== 1) {
		return;
	}
	try {
		socket.send(JSON.stringify({ type: "ping" }));
	} catch {
		// If the send throws the connection is already broken; let the
		// watchdog/onclose path drive recovery.
	}
	// Expect any inbound frame within the timeout window. If none arrives the
	// connection is half-open, so force a close to trigger reconnect + reload.
	if (watchdogTimer) {
		clearTimeout(watchdogTimer);
	}
	watchdogTimer = setTimeout(() => {
		watchdogTimer = null;
		forceReconnect();
	}, getHeartbeatTimeoutMs());
}

function startHeartbeat() {
	clearHeartbeatTimers();
	heartbeatTimer = setInterval(() => {
		sendPing();
	}, getHeartbeatIntervalMs());
}

// Force-close a (possibly half-open) socket so the existing onclose ->
// reconnect -> reconnectCount -> page reload path runs and pulls a fresh
// REST snapshot.
function forceReconnect() {
	clearHeartbeatTimers();
	if (!socket) {
		if (shouldReconnect && !reconnectTimer) {
			reconnectTimer = setTimeout(connect, getReconnectDelayMs());
		}
		return;
	}
	socket.close();
}

function isSocketHealthy(): boolean {
	return socket !== null && socket.readyState === 1;
}

// Returning to a backgrounded tab or regaining network connectivity should
// recover a stalled connection. If the socket is not healthy we reconnect
// immediately; if it looks open we probe it with a ping so the watchdog can
// catch a silently dead connection.
function handleRecoveryTrigger() {
	if (!shouldReconnect) {
		return;
	}
	if (isSocketHealthy()) {
		sendPing();
		return;
	}
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	connect();
}

function handleVisibilityChange() {
	if (typeof document !== "undefined" && document.visibilityState !== "visible") {
		return;
	}
	handleRecoveryTrigger();
}

function attachRecoveryListeners() {
	if (recoveryListenersAttached) {
		return;
	}
	if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
		document.addEventListener("visibilitychange", handleVisibilityChange);
	}
	if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
		window.addEventListener("focus", handleRecoveryTrigger);
		window.addEventListener("online", handleRecoveryTrigger);
	}
	recoveryListenersAttached = true;
}

function detachRecoveryListeners() {
	if (!recoveryListenersAttached) {
		return;
	}
	if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
		document.removeEventListener("visibilitychange", handleVisibilityChange);
	}
	if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
		window.removeEventListener("focus", handleRecoveryTrigger);
		window.removeEventListener("online", handleRecoveryTrigger);
	}
	recoveryListenersAttached = false;
}

export function connect() {
	if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
		return;
	}

	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}

	// Replacing a stale (connecting=0 is handled by the guard above; this path
	// only sees closing=2/closed=3) socket: detach its handlers and close it so
	// a delayed callback can't tear down the fresh connection we create below.
	if (socket) {
		detachSocketHandlers(socket);
		try {
			socket.close();
		} catch {
			// already closed; ignore
		}
	}

	shouldReconnect = true;
	attachRecoveryListeners();
	wsState.update((state) => ({ ...state, status: "connecting" }));
	const WebSocketCtor = getWebSocketCtor();
	const currentSocket = new WebSocketCtor(resolveWsUrl());
	socket = currentSocket;

	currentSocket.onopen = () => {
		// Ignore events from a socket that is no longer the active one.
		if (socket !== currentSocket) return;
		wsState.update((state) => ({
			...state,
			status: "connected",
			reconnectCount: hasConnectedBefore ? state.reconnectCount + 1 : state.reconnectCount,
		}));
		hasConnectedBefore = true;
		startHeartbeat();
	};

	currentSocket.onmessage = (event) => {
		if (socket !== currentSocket) return;
		// Treat every inbound frame as a liveness signal before parsing.
		noteInboundMessage();
		try {
			const raw = typeof event.data === "string" ? event.data : String(event.data);
			const frame = parseIncomingWsFrame(JSON.parse(raw));
			if (!frame) {
				return;
			}

			if (frame.type === "hello") {
				wsState.update((state) => ({
					...state,
					serverVersion: frame.payload.serverVersion,
				}));
				return;
			}
			if (frame.type === "pong") return;

			eventHandler?.(frame);
		} catch {
			// ignore malformed frames
		}
	};

	currentSocket.onclose = () => {
		if (socket !== currentSocket) return;
		clearHeartbeatTimers();
		wsState.update((state) => ({ ...state, status: "disconnected" }));
		socket = null;
		if (shouldReconnect && !reconnectTimer) {
			reconnectTimer = setTimeout(connect, getReconnectDelayMs());
		}
	};

	currentSocket.onerror = () => {
		if (socket !== currentSocket) return;
		currentSocket.close();
	};
}

export function disconnect() {
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	clearHeartbeatTimers();
	detachRecoveryListeners();
	shouldReconnect = false;
	socket?.close();
	socket = null;
	wsState.update((state) => ({ ...state, status: "disconnected" }));
}
