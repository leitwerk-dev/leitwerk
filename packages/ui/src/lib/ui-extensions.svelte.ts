import type {
	BrowserUiExtensionAPI,
	BrowserUiExtensionContext,
	BrowserUiExtensionModule,
	BrowserUiShellIndicatorRegistration,
	BrowserUiShortcutRegistration,
	BrowserUiWsFrameHandler,
} from "@leitwerk-dev/process-sdk";
import {
	type BrowserUiExtensionDescriptor,
	browserUiExtensionDescriptorSchema,
	type WsFrame,
} from "@leitwerk-dev/protocol";
import { derived, get, type Writable, writable } from "svelte/store";
import * as v from "valibot";
import { getFetchImpl, getModuleImporter, resolveApiUrl, resolveServerUrl } from "./runtime-config";

export type { BrowserUiExtensionDescriptor } from "@leitwerk-dev/protocol";

interface BrowserUiExtensionsResponse {
	ok?: unknown;
	extensions?: unknown;
}

export type RegisteredBrowserUiShortcut = BrowserUiShortcutRegistration & {
	extensionManifestId: string;
};

export type RegisteredBrowserUiShellIndicator = BrowserUiShellIndicatorRegistration & {
	extensionManifestId: string;
};

type BrowserUiExtensionDisposer = () => void;
type BrowserUiExtensionDisposerTracker = (disposer: BrowserUiExtensionDisposer) => void;

interface BrowserUiExtensionApiOptions {
	trackDisposer?: BrowserUiExtensionDisposerTracker;
	isActive?: () => boolean;
}

const shortcutStore = writable<RegisteredBrowserUiShortcut[]>([]);
const indicatorStore = writable<RegisteredBrowserUiShellIndicator[]>([]);

export const browserUiExtensionShortcuts = derived(shortcutStore, (items) => items);
export const browserUiExtensionShortcutHelpItems = derived(shortcutStore, (items) =>
	items.map((item) => ({ keys: item.keys, label: item.label })),
);
export const browserUiExtensionShellIndicators = derived(indicatorStore, (items) => items);

const frameHandlers = new Set<BrowserUiWsFrameHandler>();
let loadPromise: Promise<void> | null = null;

export const BROWSER_UI_EXTENSION_API_VERSION = 1;

function parseExtensionsResponse(value: unknown): BrowserUiExtensionDescriptor[] {
	const response = value as BrowserUiExtensionsResponse;
	if (!response || typeof response !== "object" || response.ok !== true) {
		return [];
	}
	if (!Array.isArray(response.extensions)) {
		return [];
	}
	return response.extensions.filter((value): value is BrowserUiExtensionDescriptor =>
		v.is(browserUiExtensionDescriptorSchema, value),
	);
}

function describeUnknownError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return "unknown error";
}

function reportBrowserUiExtensionIssue(message: string, error?: unknown): void {
	const detail = error === undefined ? "" : `: ${describeUnknownError(error)}`;
	console.warn(`[browser-ui-extension] ${message}${detail}`);
}

function resolveBrowserModule(value: unknown): BrowserUiExtensionModule | null {
	if (typeof value === "object" && value !== null && "setup" in value) {
		const module = value as { setup?: unknown };
		return typeof module.setup === "function" ? (module as BrowserUiExtensionModule) : null;
	}
	if (typeof value === "object" && value !== null && "default" in value) {
		return resolveBrowserModule((value as { default?: unknown }).default);
	}
	return null;
}

function runSafely<T>(message: string, work: () => T, fallback: T): T {
	try {
		return work();
	} catch (error) {
		reportBrowserUiExtensionIssue(message, error);
		return fallback;
	}
}

function makeSafeDisposer(
	descriptor: BrowserUiExtensionDescriptor,
	label: string,
	disposer: BrowserUiExtensionDisposer,
): BrowserUiExtensionDisposer {
	return () =>
		runSafely(
			`${label} cleanup from extension '${descriptor.extensionManifestId}' failed`,
			disposer,
			undefined,
		);
}

function wrapShortcutRegistration(
	descriptor: BrowserUiExtensionDescriptor,
	registration: BrowserUiShortcutRegistration,
): RegisteredBrowserUiShortcut {
	return {
		...registration,
		extensionManifestId: descriptor.extensionManifestId,
		handle: (event) =>
			runSafely(
				`Shortcut '${registration.id}' from extension '${descriptor.extensionManifestId}' failed`,
				() => registration.handle(event),
				false,
			),
	};
}

function wrapIndicatorRegistration(
	descriptor: BrowserUiExtensionDescriptor,
	registration: BrowserUiShellIndicatorRegistration,
): RegisteredBrowserUiShellIndicator {
	return {
		...registration,
		extensionManifestId: descriptor.extensionManifestId,
		mount(host) {
			const cleanup = runSafely(
				`Indicator '${registration.id}' from extension '${descriptor.extensionManifestId}' failed to mount`,
				() => registration.mount(host),
				undefined,
			);
			if (typeof cleanup !== "function") {
				return undefined;
			}
			return makeSafeDisposer(descriptor, `Indicator '${registration.id}'`, cleanup);
		},
	};
}

const noopDisposer: BrowserUiExtensionDisposer = () => {};

function createApi(
	descriptor: BrowserUiExtensionDescriptor,
	options: BrowserUiExtensionApiOptions = {},
): BrowserUiExtensionAPI {
	function contributionAllowed(label: string): boolean {
		if (options.isActive?.() !== false) {
			return true;
		}
		reportBrowserUiExtensionIssue(
			`${label} from extension '${descriptor.extensionManifestId}' ignored because module setup failed`,
		);
		return false;
	}

	function registerContribution<T extends { id: string; extensionManifestId: string }>(
		store: Writable<T[]>,
		label: string,
		createItem: () => T,
	): BrowserUiExtensionDisposer {
		if (!contributionAllowed(label)) return noopDisposer;
		const item = createItem();
		const withoutItem = (items: T[]) =>
			items.filter(
				(existing) =>
					existing.extensionManifestId !== item.extensionManifestId || existing.id !== item.id,
			);
		store.update((items) => [...withoutItem(items), item]);
		const unregister = makeSafeDisposer(descriptor, label, () => store.update(withoutItem));
		options.trackDisposer?.(unregister);
		return unregister;
	}

	return {
		registerShortcut(registration) {
			return registerContribution(shortcutStore, `Shortcut '${registration.id}'`, () =>
				wrapShortcutRegistration(descriptor, registration),
			);
		},
		registerShellIndicator(registration) {
			return registerContribution(indicatorStore, `Indicator '${registration.id}'`, () =>
				wrapIndicatorRegistration(descriptor, registration),
			);
		},
		onWsFrame(handler) {
			if (!contributionAllowed("WebSocket frame handler")) {
				return noopDisposer;
			}
			const wrappedHandler: BrowserUiWsFrameHandler = (frame) =>
				runSafely(
					`WebSocket frame handler from extension '${descriptor.extensionManifestId}' failed`,
					() => handler(frame),
					false,
				);
			frameHandlers.add(wrappedHandler);
			const unregister = makeSafeDisposer(descriptor, "WebSocket frame handler", () => {
				frameHandlers.delete(wrappedHandler);
			});
			options.trackDisposer?.(unregister);
			return unregister;
		},
	};
}

function createContext(descriptor: BrowserUiExtensionDescriptor): BrowserUiExtensionContext {
	return {
		extensionManifestId: descriptor.extensionManifestId,
		moduleUrl: descriptor.moduleUrl,
		resolveAssetUrl(relativePath) {
			const normalized = relativePath.replace(/^\/+/, "");
			return resolveServerUrl(
				`/ext-ui/${encodeURIComponent(descriptor.extensionManifestId)}/${normalized
					.split("/")
					.map((segment) => encodeURIComponent(segment))
					.join("/")}`,
			);
		},
	};
}

function rollBackSetupDisposers(
	descriptor: BrowserUiExtensionDescriptor,
	disposers: readonly BrowserUiExtensionDisposer[],
): void {
	for (const disposer of [...disposers].reverse()) {
		runSafely(
			`Setup rollback for extension '${descriptor.extensionManifestId}' failed`,
			disposer,
			undefined,
		);
	}
}

export function loadBrowserUiExtensions(): Promise<void> {
	loadPromise ??= (async () => {
		try {
			const response = await getFetchImpl()(resolveApiUrl("/api/ui/extensions"));
			const descriptors = parseExtensionsResponse(await response.json());
			const importModule = getModuleImporter();
			for (const descriptor of descriptors) {
				if (descriptor.browserApiVersion !== BROWSER_UI_EXTENSION_API_VERSION) {
					reportBrowserUiExtensionIssue(
						`Skipping browser UI module '${descriptor.modulePath}' from extension '${descriptor.extensionManifestId}' because it declares browserApiVersion=${descriptor.browserApiVersion}; host supports ${BROWSER_UI_EXTENSION_API_VERSION}`,
					);
					continue;
				}
				const setupDisposers: BrowserUiExtensionDisposer[] = [];
				let setupInProgress = true;
				let moduleActive = true;
				try {
					const imported = await importModule(resolveServerUrl(descriptor.moduleUrl));
					const module = resolveBrowserModule(imported);
					if (!module) {
						reportBrowserUiExtensionIssue(
							`Skipping browser UI module '${descriptor.modulePath}' from extension '${descriptor.extensionManifestId}' because it does not export setup()`,
						);
						continue;
					}
					await module.setup(
						createApi(descriptor, {
							trackDisposer(disposer) {
								if (setupInProgress) {
									setupDisposers.push(disposer);
								}
							},
							isActive: () => moduleActive,
						}),
						createContext(descriptor),
					);
					setupInProgress = false;
				} catch (error) {
					setupInProgress = false;
					moduleActive = false;
					rollBackSetupDisposers(descriptor, setupDisposers);
					reportBrowserUiExtensionIssue(
						`Browser UI module '${descriptor.modulePath}' from extension '${descriptor.extensionManifestId}' failed to set up; rolled back its registrations`,
						error,
					);
				}
			}
		} catch {
			// Extension UI is optional; the shell continues without browser modules.
		}
	})();
	return loadPromise;
}

function shortcutMatches(event: KeyboardEvent, shortcut: BrowserUiShortcutRegistration): boolean {
	const eventKey = event.key.length === 1 ? event.key.toLowerCase() : event.key;
	return shortcut.keys.some((key) => {
		const shortcutKey = key.length === 1 ? key.toLowerCase() : key;
		return shortcutKey === eventKey;
	});
}

export function dispatchBrowserUiExtensionShortcut(event: KeyboardEvent): boolean {
	for (const item of get(shortcutStore)) {
		if (shortcutMatches(event, item) && item.handle(event) === true) {
			return true;
		}
	}
	return false;
}

export function dispatchBrowserUiExtensionWsFrame(frame: WsFrame): boolean {
	for (const handler of [...frameHandlers]) {
		if (handler(frame) === true) {
			return true;
		}
	}
	return false;
}

export function resetBrowserUiExtensionsForTest(): void {
	shortcutStore.set([]);
	indicatorStore.set([]);
	frameHandlers.clear();
	loadPromise = null;
}
