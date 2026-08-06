import * as v from "valibot";
import { getFetchImpl, getModuleImporter, resolveServerUrl } from "../../lib/runtime-config.js";

export interface LeafOutcomeRendererDescriptor {
	ok: true;
	rendererId: string;
	kind: "custom_element";
	tagName: string;
	modulePath: string;
	rendererApiVersion: number;
	extensionManifestId: string;
	moduleUrl: string;
}

interface LeafOutcomeRendererLookupFailure {
	ok: false;
	rendererId: string;
	code: string;
	message: string;
}

interface LeafOutcomeRendererLoadFailure {
	ok: false;
	rendererId: string;
	code: string;
	message: string;
}

interface LeafOutcomeRendererLoadSuccess {
	ok: true;
	descriptor: LeafOutcomeRendererDescriptor;
}

export type LeafOutcomeRendererLoadResult =
	| LeafOutcomeRendererLoadSuccess
	| LeafOutcomeRendererLoadFailure;

const LEAF_OUTCOME_RENDERER_API_VERSION = 1;

const descriptorPromiseCache = new Map<
	string,
	Promise<LeafOutcomeRendererDescriptor | LeafOutcomeRendererLookupFailure>
>();
const modulePromiseCache = new Map<string, Promise<void>>();

const unknownRecordSchema = v.pipe(
	v.unknown(),
	v.check(
		(value) => typeof value === "object" && value !== null && !Array.isArray(value),
		"Expected object",
	),
	v.record(v.string(), v.unknown()),
);

function isLookupFailure(value: unknown): value is LeafOutcomeRendererLookupFailure {
	const parsedValue = v.safeParse(unknownRecordSchema, value);
	if (!parsedValue.success) {
		return false;
	}
	const record = parsedValue.output;
	return (
		record.ok === false &&
		typeof record.rendererId === "string" &&
		typeof record.code === "string" &&
		typeof record.message === "string"
	);
}

function isDescriptor(value: unknown): value is LeafOutcomeRendererDescriptor {
	const parsedValue = v.safeParse(unknownRecordSchema, value);
	if (!parsedValue.success) {
		return false;
	}
	const record = parsedValue.output;
	return (
		record.ok === true &&
		typeof record.rendererId === "string" &&
		record.kind === "custom_element" &&
		typeof record.tagName === "string" &&
		typeof record.modulePath === "string" &&
		typeof record.rendererApiVersion === "number" &&
		typeof record.extensionManifestId === "string" &&
		typeof record.moduleUrl === "string"
	);
}

async function parseJsonResponse(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

async function fetchRendererDescriptor(
	rendererId: string,
): Promise<LeafOutcomeRendererDescriptor | LeafOutcomeRendererLookupFailure> {
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
	if (isDescriptor(body)) {
		return body;
	}
	if (isLookupFailure(body)) {
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

function getDescriptorPromise(
	rendererId: string,
): Promise<LeafOutcomeRendererDescriptor | LeafOutcomeRendererLookupFailure> {
	const cached = descriptorPromiseCache.get(rendererId);
	if (cached) {
		return cached;
	}
	const promise = fetchRendererDescriptor(rendererId);
	descriptorPromiseCache.set(rendererId, promise);
	return promise;
}

async function importRendererModule(descriptor: LeafOutcomeRendererDescriptor): Promise<void> {
	const moduleUrl = resolveServerUrl(descriptor.moduleUrl);
	await getModuleImporter()(moduleUrl);
}

function getModuleImportPromise(descriptor: LeafOutcomeRendererDescriptor): Promise<void> {
	const cacheKey = resolveServerUrl(descriptor.moduleUrl);
	const cached = modulePromiseCache.get(cacheKey);
	if (cached) {
		return cached;
	}
	const promise = importRendererModule(descriptor);
	modulePromiseCache.set(cacheKey, promise);
	return promise;
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
		await getModuleImportPromise(descriptor);
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
