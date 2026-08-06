import type { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import type { ProvidedCapability } from "@leitwerk-dev/process-sdk";
import {
	type AppContext,
	createAppContext,
	getDefaultConfig,
	type LeitwerkConfig,
} from "@leitwerk-dev/server";
import { createInProcessWorkerSpawn } from "@leitwerk-dev/test-support/worker-testing";
import { vi } from "vitest";
import type {
	UiModuleImporter,
	UiWebSocketCtor,
	UiWebSocketLike,
} from "../../packages/ui/src/lib/runtime-config.ts";

const require = createRequire(import.meta.url);

export interface UiTestApp<TResources extends Record<string, unknown> = Record<string, never>> {
	ctx: AppContext;
	address: string;
	wsAddress: string;
	resources: TResources;
	close: () => Promise<void>;
}

interface WebSocketObserver {
	closeActive(): void;
	getCreatedCount(): number;
	getReceivedCount(): number;
	hasOpenSocket(): boolean;
	reset(): void;
	webSocketCtor: UiWebSocketCtor;
}

export interface FetchHarness {
	fetchImpl: typeof fetch;
	count: (path: string) => number;
	failNext: (path: string, status?: number) => void;
	respondNext: (
		path: string,
		responder: Response | Promise<Response> | (() => Response | Promise<Response>),
	) => void;
}

export interface MountedUiHarness<TResources extends Record<string, unknown>> {
	testApp: UiTestApp<TResources>;
	mounted: object;
	disconnect: () => void;
	resetRuntimeTransport: () => void;
	socketObserver: {
		closeActive(): void;
		getCreatedCount(): number;
		getReceivedCount(): number;
		hasOpenSocket(): boolean;
		reset(): void;
	};
	unmountApp: (app: object) => void;
	fetchHarness: FetchHarness;
}

export interface SetupMountedUiHarnessOptions<
	TResources extends Record<string, unknown> = Record<string, never>,
> {
	extensionCatalog: ExtensionCatalog | Promise<ExtensionCatalog>;
	preProvidedCapabilities?: readonly ProvidedCapability[];
	resources?: TResources;
	prepare?: (testApp: UiTestApp<TResources>) => Promise<void> | void;
	route?: string | ((testApp: UiTestApp<TResources>) => string);
	fastReconnect?: boolean;
	localWorkerSpawnImpl?: typeof spawn;
	configureConfig?: (config: LeitwerkConfig) => void;
	initialFetchFailures?: readonly { path: string; status?: number }[];
}

function createWebSocketObserver(baseCtor: UiWebSocketCtor): WebSocketObserver {
	let createdCount = 0;
	let receivedCount = 0;
	const activeSockets = new Set<UiWebSocketLike>();

	class ObservedWebSocket implements UiWebSocketLike {
		private readonly inner: UiWebSocketLike;
		readyState = 0;
		url: string;
		onopen: ((event: Event) => void) | null = null;
		onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
		onclose: ((event: Event) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;

		constructor(url: string) {
			this.url = url;
			this.inner = new baseCtor(url);
			this.readyState = this.inner.readyState;
			createdCount++;
			activeSockets.add(this);

			this.inner.onopen = (event) => {
				this.readyState = this.inner.readyState;
				this.onopen?.(event);
			};
			this.inner.onmessage = (event) => {
				this.readyState = this.inner.readyState;
				receivedCount += 1;
				this.onmessage?.(event);
			};
			this.inner.onclose = (event) => {
				this.readyState = this.inner.readyState;
				activeSockets.delete(this);
				this.onclose?.(event);
			};
			this.inner.onerror = (event) => {
				this.readyState = this.inner.readyState;
				this.onerror?.(event);
			};
		}

		send(data: string) {
			this.inner.send(data);
		}

		close() {
			this.inner.close();
		}
	}

	return {
		closeActive() {
			const socket = [...activeSockets].find((candidate) => candidate.readyState === 1);
			socket?.close();
		},
		getCreatedCount() {
			return createdCount;
		},
		getReceivedCount() {
			return receivedCount;
		},
		hasOpenSocket() {
			return [...activeSockets].some((candidate) => candidate.readyState === 1);
		},
		reset() {
			const sockets = [...activeSockets];
			activeSockets.clear();
			for (const socket of sockets) {
				if (socket.readyState !== 3) {
					socket.close();
				}
			}
		},
		webSocketCtor: ObservedWebSocket,
	};
}

export async function waitFor<T>(assertion: () => T, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;

	while (Date.now() < deadline) {
		try {
			return assertion();
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	if (lastError instanceof Error) {
		throw lastError;
	}

	throw new Error("Timed out waiting for UI assertion");
}

function createFetchHarness<TResources extends Record<string, unknown>>(
	testApp: UiTestApp<TResources>,
): FetchHarness {
	const realFetch = globalThis.fetch;
	const calls: string[] = [];
	const failures = new Map<string, number>();
	const responders = new Map<
		string,
		Array<Response | Promise<Response> | (() => Response | Promise<Response>)>
	>();

	const fetchImpl: typeof fetch = async (input, init) => {
		const url =
			input instanceof Request
				? new URL(input.url)
				: input instanceof URL
					? input
					: new URL(String(input), testApp.address);
		const path = `${url.pathname}${url.search}`;
		calls.push(path);

		const queuedResponders = responders.get(path);
		const responder = queuedResponders?.shift();
		if (queuedResponders && queuedResponders.length === 0) {
			responders.delete(path);
		}
		if (responder) {
			return await (typeof responder === "function" ? responder() : responder);
		}

		const status = failures.get(path);
		if (status !== undefined) {
			failures.delete(path);
			return new Response(JSON.stringify({ error: `forced ${status}` }), {
				status,
				headers: { "content-type": "application/json" },
			});
		}

		return realFetch(url, init);
	};

	return {
		fetchImpl,
		count(path: string) {
			return calls.filter((call) => call === path).length;
		},
		failNext(path: string, status = 503) {
			failures.set(path, status);
		},
		respondNext(path, responder) {
			const queuedResponders = responders.get(path) ?? [];
			queuedResponders.push(responder);
			responders.set(path, queuedResponders);
		},
	};
}

function buildModuleImportDataUrl(source: string, sourceUrl: string): string {
	const annotatedSource = `${source}\n//# sourceURL=${sourceUrl}`;
	return `data:text/javascript;charset=utf-8,${encodeURIComponent(annotatedSource)}`;
}

function createUiTestModuleImporter(fetchImpl: typeof fetch): UiModuleImporter {
	return async (url) => {
		const response = await fetchImpl(url);
		if (!response.ok) {
			throw new Error(`Module request failed with status ${response.status}`);
		}
		const source = await response.text();
		return import(/* @vite-ignore */ buildModuleImportDataUrl(source, url));
	};
}

async function resolveTestWebSocketCtor(): Promise<UiWebSocketCtor> {
	const wsModule = require("ws") as { WebSocket?: unknown; default?: unknown };
	const ctor = (wsModule.WebSocket ?? wsModule.default ?? wsModule) as unknown;
	if (typeof ctor !== "function") {
		throw new Error("ws module did not expose a constructable WebSocket");
	}
	return ctor as UiWebSocketCtor;
}

export async function createUiTestApp<
	TResources extends Record<string, unknown> = Record<string, never>,
>(
	options: Pick<
		SetupMountedUiHarnessOptions<TResources>,
		| "extensionCatalog"
		| "preProvidedCapabilities"
		| "resources"
		| "localWorkerSpawnImpl"
		| "configureConfig"
	>,
): Promise<UiTestApp<TResources>> {
	const extensionCatalog = await Promise.resolve(options.extensionCatalog);
	const config = getDefaultConfig();
	const runtimeRoot = await mkdtemp(path.join(tmpdir(), "leitwerk-ui-"));
	config.workers.runner = "local";
	config.storage.process_workspaces_dir = path.join(runtimeRoot, "workspaces");
	config.storage.tree_files_dir = path.join(runtimeRoot, "sessions");
	config.pi.agent_dir = path.join(runtimeRoot, "pi-agent");
	options.configureConfig?.(config);
	const ctx = await createAppContext({
		logger: false,
		config,
		extensionCatalog,
		extensionUiRuntimeLane: "dist",
		preProvidedCapabilities: options.preProvidedCapabilities,
		localWorkerSpawnImpl:
			options.localWorkerSpawnImpl ?? createInProcessWorkerSpawn({ extensionCatalog }),
	});
	await ctx.app.listen({ host: "127.0.0.1", port: 0 });

	const addressInfo = ctx.app.server.address();
	const port = typeof addressInfo === "object" && addressInfo ? addressInfo.port : 0;
	const address = `http://127.0.0.1:${port}`;
	ctx.config.server.base_url = address;

	return {
		ctx,
		address,
		wsAddress: `ws://127.0.0.1:${port}/ws`,
		resources: options.resources ?? ({} as TResources),
		close: async () => {
			try {
				await ctx.app.close();
			} finally {
				await rm(runtimeRoot, { recursive: true, force: true });
			}
		},
	};
}

export async function setupMountedUiHarness<
	TResources extends Record<string, unknown> = Record<string, never>,
>(opts: SetupMountedUiHarnessOptions<TResources>): Promise<MountedUiHarness<TResources>> {
	const testApp = await createUiTestApp(opts);
	await opts.prepare?.(testApp);

	const fetchHarness = createFetchHarness(testApp);
	for (const failure of opts.initialFetchFailures ?? []) {
		fetchHarness.failNext(failure.path, failure.status);
	}
	const route = typeof opts.route === "function" ? opts.route(testApp) : (opts.route ?? "/");
	document.body.innerHTML = "";
	window.history.replaceState(null, "", route);

	const reconnectDelayMs = opts.fastReconnect ? 0 : 3_000;

	vi.resetModules();
	const runtimeConfig = await import("./ui-runtime-transport.js");
	const webSocketCtor = await resolveTestWebSocketCtor();
	const socketObserver = createWebSocketObserver(webSocketCtor);
	runtimeConfig.configureUiRuntimeTransport({
		apiBaseUrl: testApp.address,
		wsUrl: testApp.wsAddress,
		reconnectDelayMs,
		fetchImpl: fetchHarness.fetchImpl,
		webSocketCtor: socketObserver.webSocketCtor,
		moduleImporter: createUiTestModuleImporter(fetchHarness.fetchImpl),
	});

	const svelteRuntime = await import("svelte");
	const { default: App } = await import("../../packages/ui/src/App.svelte");
	const { disconnect } = await import("../../packages/ui/src/lib/ws.svelte.ts");

	const target = document.createElement("div");
	document.body.appendChild(target);
	const mounted = svelteRuntime.mount(App, { target });

	return {
		testApp,
		mounted,
		disconnect,
		resetRuntimeTransport: runtimeConfig.resetUiRuntimeTransport,
		socketObserver,
		unmountApp: (app) => svelteRuntime.unmount(app as never),
		fetchHarness,
	};
}

export async function teardownMountedUiHarness(
	harness: MountedUiHarness<Record<string, unknown>> | null,
) {
	try {
		harness?.disconnect();
	} finally {
		if (harness?.mounted) {
			harness.unmountApp(harness.mounted);
		}
		harness?.resetRuntimeTransport();
		harness?.socketObserver.reset();
		document.body.innerHTML = "";
		await harness?.testApp.close();
	}
}
