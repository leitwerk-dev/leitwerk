import type { BrowserUiExtensionAPI } from "@leitwerk-dev/process-sdk";
import { createEphemeralWsFrame } from "@leitwerk-dev/protocol";
import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	configureUiRuntimeTransport,
	resetUiRuntimeTransport,
} from "../../../../tests/helpers/ui-runtime-transport.js";
import {
	browserUiExtensionShellIndicators,
	browserUiExtensionShortcutHelpItems,
	dispatchBrowserUiExtensionShortcut,
	dispatchBrowserUiExtensionWsFrame,
	loadBrowserUiExtensions,
	resetBrowserUiExtensionsForTest,
} from "./ui-extensions.svelte.js";

afterEach(() => {
	resetBrowserUiExtensionsForTest();
	resetUiRuntimeTransport();
	vi.restoreAllMocks();
});

describe("browser UI extensions", () => {
	it("loads browser modules and exposes generic shortcuts, indicators, and frame handlers", async () => {
		const frameHandler = vi.fn(() => true);
		const shortcutHandler = vi.fn(() => true);
		const indicatorMount = vi.fn();
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						ok: true,
						extensions: [
							{
								extensionManifestId: "sample-extension",
								modulePath: "assets/browser.js",
								moduleUrl: "/ext-ui/sample-extension/assets/browser.js",
								browserApiVersion: 1,
							},
						],
					}),
				),
		);
		const moduleImporter = vi.fn(async () => ({
			default: {
				setup(api: BrowserUiExtensionAPI) {
					api.registerShortcut({
						id: "toggle",
						keys: ["x"],
						label: "Toggle sample extension",
						handle: shortcutHandler,
					});
					api.registerShellIndicator({
						id: "status",
						label: "Sample status",
						mount: indicatorMount,
					});
					api.onWsFrame(frameHandler);
				},
			},
		}));
		configureUiRuntimeTransport({
			fetchImpl: fetchImpl as unknown as typeof fetch,
			moduleImporter,
		});

		await loadBrowserUiExtensions();

		expect(fetchImpl).toHaveBeenCalledWith("/api/ui/extensions");
		expect(moduleImporter).toHaveBeenCalledWith("/ext-ui/sample-extension/assets/browser.js");
		expect(get(browserUiExtensionShortcutHelpItems)).toEqual([
			{ keys: ["x"], label: "Toggle sample extension" },
		]);
		expect(get(browserUiExtensionShellIndicators)).toHaveLength(1);
		expect(dispatchBrowserUiExtensionShortcut({ key: "x" } as KeyboardEvent)).toBe(true);
		expect(shortcutHandler).toHaveBeenCalledOnce();

		const claimed = dispatchBrowserUiExtensionWsFrame(
			createEphemeralWsFrame({ type: "pong", payload: {} }),
		);
		expect(claimed).toBe(true);
		expect(frameHandler).toHaveBeenCalledOnce();
	});

	it("skips browser modules with unsupported API versions", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						ok: true,
						extensions: [
							{
								extensionManifestId: "future-extension",
								modulePath: "assets/browser.js",
								moduleUrl: "/ext-ui/future-extension/assets/browser.js",
								browserApiVersion: 99,
							},
						],
					}),
				),
		);
		const moduleImporter = vi.fn(async () => ({ default: { setup() {} } }));
		configureUiRuntimeTransport({
			fetchImpl: fetchImpl as unknown as typeof fetch,
			moduleImporter,
		});

		await loadBrowserUiExtensions();

		expect(moduleImporter).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("browserApiVersion=99"));
		expect(get(browserUiExtensionShortcutHelpItems)).toEqual([]);
	});

	it("rolls back contributions when module setup fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const frameHandler = vi.fn(() => true);
		const shortcutHandler = vi.fn(() => true);
		let capturedApi: BrowserUiExtensionAPI | null = null;
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						ok: true,
						extensions: [
							{
								extensionManifestId: "bad-extension",
								modulePath: "assets/browser.js",
								moduleUrl: "/ext-ui/bad-extension/assets/browser.js",
								browserApiVersion: 1,
							},
						],
					}),
				),
		);
		const moduleImporter = vi.fn(async () => ({
			default: {
				setup(api: BrowserUiExtensionAPI) {
					capturedApi = api;
					api.registerShortcut({
						id: "toggle",
						keys: ["x"],
						label: "Broken shortcut",
						handle: shortcutHandler,
					});
					api.registerShellIndicator({
						id: "status",
						label: "Broken status",
						mount: vi.fn(),
					});
					api.onWsFrame(frameHandler);
					throw new Error("setup boom");
				},
			},
		}));
		configureUiRuntimeTransport({
			fetchImpl: fetchImpl as unknown as typeof fetch,
			moduleImporter,
		});

		await loadBrowserUiExtensions();

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("rolled back its registrations"));
		expect(get(browserUiExtensionShortcutHelpItems)).toEqual([]);
		expect(get(browserUiExtensionShellIndicators)).toEqual([]);
		expect(dispatchBrowserUiExtensionShortcut({ key: "x" } as KeyboardEvent)).toBe(false);
		expect(
			dispatchBrowserUiExtensionWsFrame(createEphemeralWsFrame({ type: "pong", payload: {} })),
		).toBe(false);
		expect(shortcutHandler).not.toHaveBeenCalled();
		expect(frameHandler).not.toHaveBeenCalled();

		capturedApi?.registerShortcut({
			id: "late-toggle",
			keys: ["l"],
			label: "Late broken shortcut",
			handle: shortcutHandler,
		});
		expect(get(browserUiExtensionShortcutHelpItems)).toEqual([]);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("ignored because module setup failed"),
		);
	});

	it("isolates shortcut and indicator contribution failures", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const cleanup = vi.fn(() => {
			throw new Error("cleanup boom");
		});
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						ok: true,
						extensions: [
							{
								extensionManifestId: "fragile-extension",
								modulePath: "assets/browser.js",
								moduleUrl: "/ext-ui/fragile-extension/assets/browser.js",
								browserApiVersion: 1,
							},
						],
					}),
				),
		);
		const moduleImporter = vi.fn(async () => ({
			default: {
				setup(api: BrowserUiExtensionAPI) {
					api.registerShortcut({
						id: "toggle",
						keys: ["x"],
						label: "Fragile shortcut",
						handle: () => {
							throw new Error("shortcut boom");
						},
					});
					api.registerShellIndicator({
						id: "mount-boom",
						label: "Mount boom",
						mount: () => {
							throw new Error("mount boom");
						},
					});
					api.registerShellIndicator({
						id: "cleanup-boom",
						label: "Cleanup boom",
						mount: () => cleanup,
					});
				},
			},
		}));
		configureUiRuntimeTransport({
			fetchImpl: fetchImpl as unknown as typeof fetch,
			moduleImporter,
		});

		await loadBrowserUiExtensions();

		expect(dispatchBrowserUiExtensionShortcut({ key: "x" } as KeyboardEvent)).toBe(false);
		const indicators = get(browserUiExtensionShellIndicators);
		expect(indicators).toHaveLength(2);
		expect(() => indicators[0]?.mount({} as HTMLElement)).not.toThrow();
		const cleanupDisposer = indicators[1]?.mount({} as HTMLElement);
		expect(() => cleanupDisposer?.()).not.toThrow();
		expect(cleanup).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Shortcut 'toggle'"));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Indicator 'mount-boom'"));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Indicator 'cleanup-boom'"));
	});
});
