import {
	type LeafOutcomeRendererDescriptor,
	type LeafOutcomeRendererFailure,
	leafOutcomeRendererDescriptorSchema,
	leafOutcomeRendererFailureSchema,
} from "@leitwerk-dev/protocol";
import * as v from "valibot";
import { tryReadJson as parseJsonResponse } from "../../lib/http-client.js";
import { getFetchImpl, getModuleImporter, resolveServerUrl } from "../../lib/runtime-config.js";

export type { LeafOutcomeRendererDescriptor } from "@leitwerk-dev/protocol";

interface LeafOutcomeRendererLoadSuccess {
	ok: true;
	descriptor: LeafOutcomeRendererDescriptor;
}

export type LeafOutcomeRendererLoadResult =
	| LeafOutcomeRendererLoadSuccess
	| LeafOutcomeRendererFailure;

const LEAF_OUTCOME_RENDERER_API_VERSION = 1;

function memoizePromise<T>(load: (key: string) => Promise<T>) {
	const cache = new Map<string, Promise<T>>();
	return (key: string): Promise<T> => {
		const cached = cache.get(key);
		if (cached) {
			return cached;
		}
		const promise = load(key);
		cache.set(key, promise);
		return promise;
	};
}

const getDescriptorPromise = memoizePromise(fetchRendererDescriptor);
const importRendererModule = memoizePromise(async (moduleUrl: string) => {
	await getModuleImporter()(moduleUrl);
});

async function fetchRendererDescriptor(
	rendererId: string,
): Promise<LeafOutcomeRendererDescriptor | LeafOutcomeRendererFailure> {
	let response: Response;
	try {
		response = await getFetchImpl()(
			resolveServerUrl(`/api/ui/renderers/${encodeURIComponent(rendererId)}`),
		);
	} catch (error) {
		return {
			ok: false,
			rendererId,
			code: "renderer_lookup_failed",
			message: error instanceof Error ? error.message : "Renderer lookup request failed",
		};
	}
	const body = await parseJsonResponse(response);
	if (
		v.is(leafOutcomeRendererDescriptorSchema, body) ||
		v.is(leafOutcomeRendererFailureSchema, body)
	) {
		return body;
	}
	if (!response.ok) {
		return {
			ok: false,
			rendererId,
			code: response.status === 404 ? "renderer_not_found" : "renderer_lookup_failed",
			message:
				response.status === 404
					? "Renderer is not available for any loaded extension UI bundle"
					: `Renderer lookup failed with status ${response.status}`,
		};
	}
	return {
		ok: false,
		rendererId,
		code: "invalid_renderer_descriptor",
		message: "Renderer lookup returned an invalid descriptor payload",
	};
}

export async function loadLeafOutcomeRenderer(
	rendererId: string,
): Promise<LeafOutcomeRendererLoadResult> {
	const descriptor = await getDescriptorPromise(rendererId);
	if (!descriptor.ok) {
		return descriptor;
	}
	if (descriptor.rendererApiVersion !== LEAF_OUTCOME_RENDERER_API_VERSION) {
		return {
			ok: false,
			rendererId,
			code: "renderer_api_version_mismatch",
			message: `Renderer API version ${descriptor.rendererApiVersion} is not supported by this UI host`,
		};
	}
	if (
		typeof customElements === "undefined" ||
		typeof customElements.get !== "function" ||
		typeof customElements.define !== "function"
	) {
		return {
			ok: false,
			rendererId,
			code: "custom_elements_unavailable",
			message: "This browser environment does not support custom element renderers",
		};
	}
	try {
		await importRendererModule(resolveServerUrl(descriptor.moduleUrl));
	} catch (error) {
		return {
			ok: false,
			rendererId,
			code: "renderer_module_import_failed",
			message: error instanceof Error ? error.message : "Renderer module failed to load",
		};
	}
	if (!customElements.get(descriptor.tagName)) {
		return {
			ok: false,
			rendererId,
			code: "custom_element_not_registered",
			message: `Renderer module loaded but did not register custom element '${descriptor.tagName}'`,
		};
	}
	return {
		ok: true,
		descriptor,
	};
}
