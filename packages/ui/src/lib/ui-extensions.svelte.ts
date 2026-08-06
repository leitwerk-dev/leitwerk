import type {
	BrowserUiExtensionAPI,
	BrowserUiExtensionContext,
	BrowserUiExtensionModule,
	BrowserUiShellIndicatorRegistration,
	BrowserUiShortcutRegistration,
	BrowserUiWsFrameHandler,
} from "@leitwerk-dev/process-sdk";
import type { WsFrame } from "@leitwerk-dev/protocol";
import { derived, get, writable } from "svelte/store";
import { getFetchImpl, getModuleImporter, resolveApiUrl, resolveServerUrl } from "./runtime-config";

export interface BrowserUiExtensionDescriptor {
	extensionManifestId: string;
	modulePath: string;
	moduleUrl: string;
	browserApiVersion: number;
}

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

const frameHandlers: BrowserUiWsFrameHandler[] = [];
let loadPromise: Promise<void> | null = null;

export const BROWSER_UI_EXTENSION_API_VERSION = 1;

function isDescriptor(value: unknown): value is BrowserUiExtensionDescriptor {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const descriptor = value as Record<string, unknown>;
	return (
		typeof descriptor.extensionManifestId === "string" &&
		typeof descriptor.modulePath === "string" &&
		typeof descriptor.moduleUrl === "string" &&
		typeof descriptor.browserApiVersion === "number"
	);
}

function parseExtensionsResponse(value: unknown): BrowserUiExtensionDescriptor[] {
	const response = value as BrowserUiExtensionsResponse;
	if (!response || typeof response !== "object" || response.ok !== true) {
		return [];
	}
	if (!Array.isArray(response.extensions)) {
		return [];
	}
	return response.extensions.filter(isDescriptor);
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

function makeSafeDisposer(
	descriptor: BrowserUiExtensionDescriptor,
	label: string,
	disposer: BrowserUiExtensionDisposer,
): BrowserUiExtensionDisposer {
	return () => {
		try {
			disposer();
		} catch (error) {
			reportBrowserUiExtensionIssue(
				`${label} cleanup from extension '${descriptor.extensionManifestId}' failed`,
				error,
			);
		}
	};
}

function wrapShortcutRegistration(
	descriptor: BrowserUiExtensionDescriptor,
	registration: BrowserUiShortcutRegistration,
): RegisteredBrowserUiShortcut {
	return {
		...registration,
		extensionManifestId: descriptor.extensionManifestId,
		handle(event) {
			try {
				return registration.handle(event);
			} catch (error) {
				reportBrowserUiExtensionIssue(
					`Shortcut '${registration.id}' from extension '${descriptor.extensionManifestId}' failed`,
					error,
				);
				return false;
			}
		},
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
			let cleanup: undefined | (() => void);
			try {
				cleanup = registration.mount(host);
			} catch (error) {
				reportBrowserUiExtensionIssue(
					`Indicator '${registration.id}' from extension '${descriptor.extensionManifestId}' failed to mount`,
					error,
				);
				return undefined;
			}
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

	return {
		registerShortcut(registration) {
			if (!contributionAllowed(`Shortcut '${registration.id}'`)) {
				return noopDisposer;
			}
			const item = wrapShortcutRegistration(descriptor, registration);
			shortcutStore.update((items) => [
				...items.filter(
					(existing) =>
						existing.extensionManifestId !== item.extensionManifestId || existing.id !== item.id,
				),
				item,
			]);
			const unregister = makeSafeDisposer(descriptor, `Shortcut '${registration.id}'`, () => {
				shortcutStore.update((items) =>
					items.filter(
						(existing) =>
							existing.extensionManifestId !== item.extensionManifestId || existing.id !== item.id,
					),
				);
			});
			options.trackDisposer?.(unregister);
			return unregister;
		},
		registerShellIndicator(registration) {
			if (!contributionAllowed(`Indicator '${registration.id}'`)) {
				return noopDisposer;
			}
			const item = wrapIndicatorRegistration(descriptor, registration);
			indicatorStore.update((items) => [
				...items.filter(
					(existing) =>
						existing.extensionManifestId !== item.extensionManifestId || existing.id !== item.id,
				),
				item,
			]);
			const unregister = makeSafeDisposer(descriptor, `Indicator '${registration.id}'`, () => {
				indicatorStore.update((items) =>
					items.filter(
						(existing) =>
							existing.extensionManifestId !== item.extensionManifestId || existing.id !== item.id,
					),
				);
			});
			options.trackDisposer?.(unregister);
			return unregister;
		},
		onWsFrame(handler) {
			if (!contributionAllowed("WebSocket frame handler")) {
				return noopDisposer;
			}
			const wrappedHandler: BrowserUiWsFrameHandler = (frame) => {
				try {
					return handler(frame);
				} catch (error) {
					reportBrowserUiExtensionIssue(
						`WebSocket frame handler from extension '${descriptor.extensionManifestId}' failed`,
						error,
					);
					return false;
				}
			};
			frameHandlers.push(wrappedHandler);
			const unregister = makeSafeDisposer(descriptor, "WebSocket frame handler", () => {
				const index = frameHandlers.indexOf(wrappedHandler);
				if (index >= 0) {
					frameHandlers.splice(index, 1);
				}
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
		try {
			disposer();
		} catch (error) {
			reportBrowserUiExtensionIssue(
				`Setup rollback for extension '${descriptor.extensionManifestId}' failed`,
				error,
			);
		}
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
		try {
			if (handler(frame) === true) {
				return true;
			}
		} catch (error) {
			reportBrowserUiExtensionIssue("WebSocket frame handler failed", error);
		}
	}
	return false;
}

export function resetBrowserUiExtensionsForTest(): void {
	shortcutStore.set([]);
	indicatorStore.set([]);
	frameHandlers.splice(0);
	loadPromise = null;
}
