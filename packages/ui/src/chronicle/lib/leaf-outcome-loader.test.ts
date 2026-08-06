import { afterEach, describe, expect, it, vi } from "vitest";
import {
	configureUiRuntimeTransport,
	resetUiRuntimeTransport,
} from "../../../../../tests/helpers/ui-runtime-transport.js";

interface RuntimeModules {
	configureUiRuntimeTransport: typeof configureUiRuntimeTransport;
	resetUiRuntimeTransport: typeof resetUiRuntimeTransport;
	loadLeafOutcomeRenderer: typeof import("./leaf-outcome-loader.js").loadLeafOutcomeRenderer;
}

function createJsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function installCustomElementsRegistry() {
	const registry = new Map<string, CustomElementConstructor>();
	(globalThis as { customElements?: unknown }).customElements = {
		get(name: string) {
			return registry.get(name);
		},
		define(name: string, ctor: CustomElementConstructor) {
			registry.set(name, ctor);
		},
	};
	return registry;
}

async function loadModules(): Promise<RuntimeModules> {
	vi.resetModules();
	const loader = await import("./leaf-outcome-loader.js");
	return {
		configureUiRuntimeTransport,
		resetUiRuntimeTransport,
		loadLeafOutcomeRenderer: loader.loadLeafOutcomeRenderer,
	};
}

afterEach(() => {
	resetUiRuntimeTransport();
	delete (globalThis as { customElements?: unknown }).customElements;
});

describe("loadLeafOutcomeRenderer", () => {
	it("caches descriptor lookup and module import work by rendererId", async () => {
		const registry = installCustomElementsRegistry();
		let fetchCount = 0;
		let importCount = 0;
		const modules = await loadModules();
		modules.configureUiRuntimeTransport({
			fetchImpl: async () => {
				fetchCount += 1;
				return createJsonResponse({
					ok: true,
					rendererId: "test:cached",
					kind: "custom_element",
					tagName: "o2-test-cached",
					modulePath: "assets/cached.js",
					rendererApiVersion: 1,
					extensionManifestId: "test-extension",
					moduleUrl: "/ext-ui/test-extension/assets/cached.js",
				});
			},
			moduleImporter: async () => {
				importCount += 1;
				if (!registry.has("o2-test-cached")) {
					registry.set("o2-test-cached", class {} as unknown as CustomElementConstructor);
				}
				return {};
			},
		});

		const first = await modules.loadLeafOutcomeRenderer("test:cached");
		const second = await modules.loadLeafOutcomeRenderer("test:cached");

		expect(first).toMatchObject({ ok: true });
		expect(second).toMatchObject({ ok: true });
		expect(fetchCount).toBe(1);
		expect(importCount).toBe(1);
	});

	it("returns renderer_not_found when the descriptor endpoint says the renderer is unavailable", async () => {
		installCustomElementsRegistry();
		const modules = await loadModules();
		modules.configureUiRuntimeTransport({
			fetchImpl: async () =>
				createJsonResponse(
					{
						ok: false,
						rendererId: "missing:renderer",
						code: "renderer_not_found",
						message: "Renderer is not available for any loaded extension UI bundle",
					},
					404,
				),
		});

		await expect(modules.loadLeafOutcomeRenderer("missing:renderer")).resolves.toEqual({
			ok: false,
			rendererId: "missing:renderer",
			code: "renderer_not_found",
			message: "Renderer is not available for any loaded extension UI bundle",
		});
	});

	it("returns renderer_lookup_failed when descriptor lookup throws", async () => {
		installCustomElementsRegistry();
		const modules = await loadModules();
		modules.configureUiRuntimeTransport({
			fetchImpl: async () => {
				throw new Error("network down");
			},
		});

		await expect(modules.loadLeafOutcomeRenderer("test:lookup-failed")).resolves.toEqual({
			ok: false,
			rendererId: "test:lookup-failed",
			code: "renderer_lookup_failed",
			message: "network down",
		});
	});

	it("returns invalid_renderer_descriptor when the descriptor payload is malformed", async () => {
		installCustomElementsRegistry();
		const modules = await loadModules();
		modules.configureUiRuntimeTransport({
			fetchImpl: async () => createJsonResponse({ ok: true, rendererId: "test:invalid" }),
		});

		await expect(modules.loadLeafOutcomeRenderer("test:invalid")).resolves.toEqual({
			ok: false,
			rendererId: "test:invalid",
			code: "invalid_renderer_descriptor",
			message: "Renderer lookup returned an invalid descriptor payload",
		});
	});

	it("returns renderer_api_version_mismatch for unsupported renderer api versions", async () => {
		installCustomElementsRegistry();
		let importerCalls = 0;
		const modules = await loadModules();
		modules.configureUiRuntimeTransport({
			fetchImpl: async () =>
				createJsonResponse({
					ok: true,
					rendererId: "test:version-mismatch",
					kind: "custom_element",
					tagName: "o2-test-version",
					modulePath: "assets/version.js",
					rendererApiVersion: 2,
					extensionManifestId: "test-extension",
					moduleUrl: "/ext-ui/test-extension/assets/version.js",
				}),
			moduleImporter: async () => {
				importerCalls += 1;
				return {};
			},
		});

		await expect(modules.loadLeafOutcomeRenderer("test:version-mismatch")).resolves.toEqual({
			ok: false,
			rendererId: "test:version-mismatch",
			code: "renderer_api_version_mismatch",
			message: "Renderer API version 2 is not supported by this UI host",
		});
		expect(importerCalls).toBe(0);
	});

	it("returns renderer_module_import_failed when the browser module import throws", async () => {
		installCustomElementsRegistry();
		const modules = await loadModules();
		modules.configureUiRuntimeTransport({
			fetchImpl: async () =>
				createJsonResponse({
					ok: true,
					rendererId: "test:import-failure",
					kind: "custom_element",
					tagName: "o2-test-import-failure",
					modulePath: "assets/import-failure.js",
					rendererApiVersion: 1,
					extensionManifestId: "test-extension",
					moduleUrl: "/ext-ui/test-extension/assets/import-failure.js",
				}),
			moduleImporter: async () => {
				throw new Error("module exploded");
			},
		});

		await expect(modules.loadLeafOutcomeRenderer("test:import-failure")).resolves.toEqual({
			ok: false,
			rendererId: "test:import-failure",
			code: "renderer_module_import_failed",
			message: "module exploded",
		});
	});

	it("returns custom_element_not_registered when the module loads without defining the declared tag", async () => {
		installCustomElementsRegistry();
		const modules = await loadModules();
		modules.configureUiRuntimeTransport({
			fetchImpl: async () =>
				createJsonResponse({
					ok: true,
					rendererId: "test:not-registered",
					kind: "custom_element",
					tagName: "o2-test-missing-tag",
					modulePath: "assets/missing-tag.js",
					rendererApiVersion: 1,
					extensionManifestId: "test-extension",
					moduleUrl: "/ext-ui/test-extension/assets/missing-tag.js",
				}),
			moduleImporter: async () => ({}),
		});

		await expect(modules.loadLeafOutcomeRenderer("test:not-registered")).resolves.toEqual({
			ok: false,
			rendererId: "test:not-registered",
			code: "custom_element_not_registered",
			message: "Renderer module loaded but did not register custom element 'o2-test-missing-tag'",
		});
	});
});
