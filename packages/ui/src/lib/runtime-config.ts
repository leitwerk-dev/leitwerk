export interface UiWebSocketLike {
	readyState: number;
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent<unknown>) => void) | null;
	onclose: ((event: Event) => void) | null;
	onerror: ((event: Event) => void) | null;
	send(data: string): void;
	close(): void;
}

export type UiWebSocketCtor = new (url: string) => UiWebSocketLike;

export type UiModuleImporter = (url: string) => Promise<unknown>;

export interface UiRuntimeTransportConfig {
	apiBaseUrl?: string | null;
	wsUrl?: string | null;
	reconnectDelayMs?: number;
	heartbeatIntervalMs?: number;
	heartbeatTimeoutMs?: number;
	fetchImpl?: typeof fetch;
	webSocketCtor?: UiWebSocketCtor | null;
	moduleImporter?: UiModuleImporter | null;
}

const DEFAULT_RECONNECT_DELAY_MS = 3_000;
// How often the client sends a {type:"ping"} liveness probe once connected.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
// How long the client waits for any inbound frame after a ping before it
// treats the socket as dead and forces a reconnect.
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;
const UI_RUNTIME_TRANSPORT_CONFIG_KEY = Symbol.for("leitwerk.uiRuntimeTransportConfig");

type GlobalWithUiRuntimeTransportConfig = typeof globalThis & {
	[UI_RUNTIME_TRANSPORT_CONFIG_KEY]?: UiRuntimeTransportConfig;
};

function getUiRuntimeTransportConfig(): UiRuntimeTransportConfig {
	return (globalThis as GlobalWithUiRuntimeTransportConfig)[UI_RUNTIME_TRANSPORT_CONFIG_KEY] ?? {};
}

export function resolveServerUrl(path: string): string {
	const { apiBaseUrl } = getUiRuntimeTransportConfig();
	if (!apiBaseUrl) {
		return path;
	}
	return new URL(path, apiBaseUrl).toString();
}

export function resolveApiUrl(path: string): string {
	return resolveServerUrl(path);
}

export function resolveWsUrl(): string {
	const { wsUrl } = getUiRuntimeTransportConfig();
	if (wsUrl) {
		return wsUrl;
	}
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${window.location.host}/ws`;
}

export function getReconnectDelayMs(): number {
	return getUiRuntimeTransportConfig().reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
}

export function getHeartbeatIntervalMs(): number {
	return getUiRuntimeTransportConfig().heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
}

export function getHeartbeatTimeoutMs(): number {
	return getUiRuntimeTransportConfig().heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
}

export function getFetchImpl(): typeof fetch {
	return getUiRuntimeTransportConfig().fetchImpl ?? globalThis.fetch.bind(globalThis);
}

export function getWebSocketCtor(): UiWebSocketCtor {
	const { webSocketCtor } = getUiRuntimeTransportConfig();
	if (webSocketCtor) {
		return webSocketCtor;
	}
	if (typeof WebSocket !== "undefined") {
		return WebSocket as unknown as UiWebSocketCtor;
	}
	throw new Error("Missing WebSocket implementation");
}

export function getModuleImporter(): UiModuleImporter {
	const { moduleImporter } = getUiRuntimeTransportConfig();
	if (moduleImporter) {
		return moduleImporter;
	}
	return (url: string) => import(/* @vite-ignore */ url);
}
