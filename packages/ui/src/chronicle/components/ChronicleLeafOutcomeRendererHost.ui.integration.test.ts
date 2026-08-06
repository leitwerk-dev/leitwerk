import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChronicleLeafOutcomeItem } from "../lib/chronicle-projection.js";

const { mockLoadLeafOutcomeRenderer } = vi.hoisted(() => ({
	mockLoadLeafOutcomeRenderer: vi.fn(),
}));

const originalOffsetHeightDescriptor = Object.getOwnPropertyDescriptor(
	HTMLElement.prototype,
	"offsetHeight",
);

vi.mock("../lib/leaf-outcome-loader.js", () => ({
	loadLeafOutcomeRenderer: mockLoadLeafOutcomeRenderer,
}));

function createLeafOutcomeSection(
	overrides: Partial<ChronicleLeafOutcomeItem> = {},
): ChronicleLeafOutcomeItem {
	return {
		kind: "leaf_outcome",
		chronologyAt: "2026-04-18T10:00:00.000Z",
		anchorId: "chronicle-leaf-outcome-los_test",
		instanceId: "agt_test",
		snapshotId: "los_test",
		leafEntryId: "assistant-1",
		turnRecordId: "trn_test",
		title: "Result",
		ownerTurnTitle: "Generate plan",
		rendererId: "test:renderer",
		schemaVersion: 1,
		props: { prompt: "Hello", markdown: "## Hello" },
		fallbackMarkdown: "## Hello",
		status: "ready",
		warningCode: null,
		warningMessage: null,
		anchoredAt: "2026-04-18T10:00:00.000Z",
		createdAt: "2026-04-18T10:00:01.000Z",
		processLifecycleStatus: "waiting",
		processSelectedTurnId: "plan_decision",
		processUpdatedAt: "2026-04-18T10:00:02.000Z",
		...overrides,
	};
}

function rendererHostProps(overrides: Partial<ChronicleLeafOutcomeItem> = {}) {
	const section = createLeafOutcomeSection(overrides);
	return {
		instanceId: section.instanceId,
		snapshotId: section.snapshotId,
		leafEntryId: section.leafEntryId,
		turnRecordId: section.turnRecordId,
		createdAt: section.createdAt,
		schemaVersion: section.schemaVersion,
		rendererId: section.rendererId,
		props: section.props,
		fallbackMarkdown: section.fallbackMarkdown,
		processLifecycleStatus: section.processLifecycleStatus,
		processSelectedTurnId: section.processSelectedTurnId,
		processUpdatedAt: section.processUpdatedAt,
	};
}

function defineCustomElement(tagName: string, ctor: CustomElementConstructor): void {
	if (!customElements.get(tagName)) {
		customElements.define(tagName, ctor);
	}
}

async function waitForAssertion(assertion: () => void, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Timed out waiting for assertion");
}

afterEach(() => {
	mockLoadLeafOutcomeRenderer.mockReset();
	document.body.innerHTML = "";
	vi.useRealTimers();
	if (originalOffsetHeightDescriptor) {
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeightDescriptor);
	}
});

describe("ChronicleLeafOutcomeRendererHost", () => {
	it("shows an invalid_renderer_payload warning without invoking the loader", async () => {
		const { default: ChronicleLeafOutcomeRendererHost } = await import(
			"./ChronicleLeafOutcomeRendererHost.svelte"
		);
		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(ChronicleLeafOutcomeRendererHost, {
			target,
			props: rendererHostProps({ props: null }),
		});

		await waitForAssertion(() =>
			expect(target.querySelector('[data-warning-code="invalid_renderer_payload"]')).not.toBeNull(),
		);
		expect(mockLoadLeafOutcomeRenderer).not.toHaveBeenCalled();
		unmount(app);
	});

	it("surfaces loader failures as inline warning blocks", async () => {
		mockLoadLeafOutcomeRenderer.mockResolvedValue({
			ok: false,
			rendererId: "test:renderer",
			code: "renderer_module_import_failed",
			message: "Module import exploded",
		});
		const { default: ChronicleLeafOutcomeRendererHost } = await import(
			"./ChronicleLeafOutcomeRendererHost.svelte"
		);
		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(ChronicleLeafOutcomeRendererHost, {
			target,
			props: rendererHostProps(),
		});

		await waitForAssertion(() =>
			expect(
				target.querySelector('[data-warning-code="renderer_module_import_failed"]'),
			).not.toBeNull(),
		);
		await waitForAssertion(() => expect(target.textContent).toContain("Module import exploded"));
		unmount(app);
	});

	it("clears transient min-height once a renderer is ready", async () => {
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
			configurable: true,
			get() {
				return 240;
			},
		});
		const tagName = "o2-test-ready-min-height-host";
		defineCustomElement(
			tagName,
			class extends HTMLElement {
				connectedCallback() {
					this.textContent = "Ready renderer";
					this.dispatchEvent(
						new CustomEvent("o2-leaf-outcome-ready", { bubbles: true, composed: true }),
					);
				}
			},
		);
		mockLoadLeafOutcomeRenderer.mockResolvedValue({
			ok: true,
			descriptor: {
				ok: true,
				rendererId: "test:renderer",
				kind: "custom_element",
				tagName,
				modulePath: "assets/ready-min-height.js",
				rendererApiVersion: 1,
				extensionManifestId: "test-extension",
				moduleUrl: "/ext-ui/test-extension/assets/ready-min-height.js",
			},
		});
		const { default: ChronicleLeafOutcomeRendererHost } = await import(
			"./ChronicleLeafOutcomeRendererHost.svelte"
		);
		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(ChronicleLeafOutcomeRendererHost, {
			target,
			props: rendererHostProps(),
		});

		await waitForAssertion(() =>
			expect(target.querySelector('[data-role="leaf-outcome-renderer-host"]')).not.toBeNull(),
		);
		const host = target.querySelector<HTMLElement>('[data-role="leaf-outcome-renderer-host"]');
		expect(host).not.toBeNull();
		if (!host) {
			throw new Error("Expected renderer host to mount");
		}
		await waitForAssertion(() => expect(host.dataset.rendererState).toBe("ready"));
		await Promise.resolve();
		expect(host.style.minHeight).toBe("");
		expect(host.textContent).toContain("Ready renderer");
		unmount(app);
	});

	it("keeps a synchronously ready renderer mounted after the readiness timeout window", async () => {
		vi.useFakeTimers();
		const tagName = "o2-test-sync-ready-timeout-host";
		defineCustomElement(
			tagName,
			class extends HTMLElement {
				connectedCallback() {
					this.textContent = "Ready renderer";
					this.dispatchEvent(
						new CustomEvent("o2-leaf-outcome-ready", { bubbles: true, composed: true }),
					);
				}
			},
		);
		mockLoadLeafOutcomeRenderer.mockResolvedValue({
			ok: true,
			descriptor: {
				ok: true,
				rendererId: "test:renderer",
				kind: "custom_element",
				tagName,
				modulePath: "assets/sync-ready-timeout.js",
				rendererApiVersion: 1,
				extensionManifestId: "test-extension",
				moduleUrl: "/ext-ui/test-extension/assets/sync-ready-timeout.js",
			},
		});
		const { default: ChronicleLeafOutcomeRendererHost } = await import(
			"./ChronicleLeafOutcomeRendererHost.svelte"
		);
		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(ChronicleLeafOutcomeRendererHost, {
			target,
			props: rendererHostProps(),
		});

		await vi.advanceTimersByTimeAsync(1_001);

		const host = target.querySelector<HTMLElement>('[data-role="leaf-outcome-renderer-host"]');
		expect(host).not.toBeNull();
		if (!host) {
			throw new Error("Expected renderer host to mount");
		}
		expect(host.dataset.rendererState).toBe("ready");
		expect(
			target.querySelector('[data-warning-code="renderer_did_not_signal_readiness"]'),
		).toBeNull();
		expect(target.textContent).toContain("Ready renderer");
		unmount(app);
	});

	it("keeps a synchronously ready renderer mounted across remounts", async () => {
		vi.useFakeTimers();
		const tagName = "o2-test-sync-ready-remount-host";
		defineCustomElement(
			tagName,
			class extends HTMLElement {
				connectedCallback() {
					this.dispatchEvent(
						new CustomEvent("o2-leaf-outcome-ready", { bubbles: true, composed: true }),
					);
				}
			},
		);
		mockLoadLeafOutcomeRenderer.mockResolvedValue({
			ok: true,
			descriptor: {
				ok: true,
				rendererId: "test:renderer",
				kind: "custom_element",
				tagName,
				modulePath: "assets/sync-ready-remount.js",
				rendererApiVersion: 1,
				extensionManifestId: "test-extension",
				moduleUrl: "/ext-ui/test-extension/assets/sync-ready-remount.js",
			},
		});
		const { default: ChronicleLeafOutcomeRendererHost } = await import(
			"./ChronicleLeafOutcomeRendererHost.svelte"
		);
		const target = document.createElement("div");
		document.body.appendChild(target);

		const mountHost = () =>
			mount(ChronicleLeafOutcomeRendererHost, {
				target,
				props: rendererHostProps(),
			});

		let app = mountHost();
		await vi.advanceTimersByTimeAsync(1_001);
		let host = target.querySelector<HTMLElement>('[data-role="leaf-outcome-renderer-host"]');
		expect(host?.dataset.rendererState).toBe("ready");
		expect(target.querySelector(tagName)).not.toBeNull();
		unmount(app);

		app = mountHost();
		await vi.advanceTimersByTimeAsync(1_001);
		host = target.querySelector<HTMLElement>('[data-role="leaf-outcome-renderer-host"]');
		expect(host?.dataset.rendererState).toBe("ready");
		expect(target.querySelector(tagName)).not.toBeNull();
		expect(
			target.querySelector('[data-warning-code="renderer_did_not_signal_readiness"]'),
		).toBeNull();
		unmount(app);
	});

	it("passes the markdown runtime helper into custom elements", async () => {
		const tagName = "o2-test-runtime-helper-host";
		defineCustomElement(
			tagName,
			class extends HTMLElement {
				connectedCallback() {
					const runtime = (
						this as HTMLElement & {
							runtime?: { markdown?: { render?: (value: string) => string } };
						}
					).runtime;
					if (typeof runtime?.markdown?.render !== "function") {
						this.dispatchEvent(
							new CustomEvent("o2-leaf-outcome-error", {
								bubbles: true,
								composed: true,
								detail: {
									code: "missing_markdown_runtime_helper",
									message: "runtime.markdown.render was not provided",
								},
							}),
						);
						return;
					}
					this.innerHTML = runtime.markdown.render("## Rendered from runtime");
					this.dispatchEvent(
						new CustomEvent("o2-leaf-outcome-ready", { bubbles: true, composed: true }),
					);
				}
			},
		);
		mockLoadLeafOutcomeRenderer.mockResolvedValue({
			ok: true,
			descriptor: {
				ok: true,
				rendererId: "test:renderer",
				kind: "custom_element",
				tagName,
				modulePath: "assets/runtime-helper.js",
				rendererApiVersion: 1,
				extensionManifestId: "test-extension",
				moduleUrl: "/ext-ui/test-extension/assets/runtime-helper.js",
			},
		});
		const { default: ChronicleLeafOutcomeRendererHost } = await import(
			"./ChronicleLeafOutcomeRendererHost.svelte"
		);
		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(ChronicleLeafOutcomeRendererHost, {
			target,
			props: rendererHostProps(),
		});

		await waitForAssertion(() => expect(target.textContent).toContain("Rendered from runtime"));
		expect(
			target.querySelector('[data-warning-code="missing_markdown_runtime_helper"]'),
		).toBeNull();
		unmount(app);
	});

	it("passes same-origin server helpers into custom elements", async () => {
		const tagName = "o2-test-server-runtime-helper-host";
		defineCustomElement(
			tagName,
			class extends HTMLElement {
				connectedCallback() {
					const runtime = (
						this as HTMLElement & {
							runtime?: {
								server?: {
									resolveUrl?: (path: string) => string;
									fetch?: (path: string) => Promise<Response>;
								};
							};
						}
					).runtime;
					if (
						typeof runtime?.server?.resolveUrl !== "function" ||
						typeof runtime?.server?.fetch !== "function"
					) {
						this.dispatchEvent(
							new CustomEvent("o2-leaf-outcome-error", {
								bubbles: true,
								composed: true,
								detail: {
									code: "missing_server_runtime_helper",
									message: "runtime.server helpers were not provided",
								},
							}),
						);
						return;
					}
					this.textContent = runtime.server.resolveUrl("/api/processes/agt_test");
					this.dispatchEvent(
						new CustomEvent("o2-leaf-outcome-ready", { bubbles: true, composed: true }),
					);
				}
			},
		);
		mockLoadLeafOutcomeRenderer.mockResolvedValue({
			ok: true,
			descriptor: {
				ok: true,
				rendererId: "test:renderer",
				kind: "custom_element",
				tagName,
				modulePath: "assets/server-runtime-helper.js",
				rendererApiVersion: 1,
				extensionManifestId: "test-extension",
				moduleUrl: "/ext-ui/test-extension/assets/server-runtime-helper.js",
			},
		});
		const { default: ChronicleLeafOutcomeRendererHost } = await import(
			"./ChronicleLeafOutcomeRendererHost.svelte"
		);
		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(ChronicleLeafOutcomeRendererHost, {
			target,
			props: rendererHostProps(),
		});

		await waitForAssertion(() => expect(target.textContent).toContain("/api/processes/agt_test"));
		expect(target.querySelector('[data-warning-code="missing_server_runtime_helper"]')).toBeNull();
		unmount(app);
	});

	it("renders a readiness-timeout warning when the custom element never signals ready", async () => {
		vi.useFakeTimers();
		const tagName = "o2-test-timeout-host";
		defineCustomElement(
			tagName,
			class extends HTMLElement {
				connectedCallback() {
					this.textContent = "Mounted but never ready";
				}
			},
		);
		mockLoadLeafOutcomeRenderer.mockResolvedValue({
			ok: true,
			descriptor: {
				ok: true,
				rendererId: "test:renderer",
				kind: "custom_element",
				tagName,
				modulePath: "assets/timeout.js",
				rendererApiVersion: 1,
				extensionManifestId: "test-extension",
				moduleUrl: "/ext-ui/test-extension/assets/timeout.js",
			},
		});
		const { default: ChronicleLeafOutcomeRendererHost } = await import(
			"./ChronicleLeafOutcomeRendererHost.svelte"
		);
		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(ChronicleLeafOutcomeRendererHost, {
			target,
			props: rendererHostProps(),
		});

		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(1_001);
		expect(
			target.querySelector('[data-warning-code="renderer_did_not_signal_readiness"]'),
		).not.toBeNull();
		unmount(app);
	});
});
