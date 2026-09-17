import { isUnknownRecord } from "@leitwerk-dev/domain";
import * as v from "valibot";

// Wire shape only; the catalog validates manifests and hosts check supported versions.
const recordSchema = v.custom<Record<string, unknown>>(isUnknownRecord);
const versionSchema = v.custom<number>((value) => typeof value === "number");

/** @internal */
export const leafOutcomeRendererDescriptorSchema = v.pipe(
	recordSchema,
	v.object({
		/** @internal */
		ok: v.literal(true),
		/** @internal */
		rendererId: v.string(),
		/** @internal */
		kind: v.literal("custom_element"),
		/** @internal */
		tagName: v.string(),
		/** @internal */
		modulePath: v.string(),
		/** @internal */
		rendererApiVersion: versionSchema,
		/** @internal */
		extensionManifestId: v.string(),
		/** @internal */
		moduleUrl: v.string(),
	}),
);
/** @internal */
export type LeafOutcomeRendererDescriptor = v.InferOutput<
	typeof leafOutcomeRendererDescriptorSchema
>;

/** @internal */
export const leafOutcomeRendererFailureSchema = v.pipe(
	recordSchema,
	v.object({
		/** @internal */
		ok: v.literal(false),
		/** @internal */
		rendererId: v.string(),
		/** @internal */
		code: v.string(),
		/** @internal */
		message: v.string(),
	}),
);
/** @internal */
export type LeafOutcomeRendererFailure = v.InferOutput<typeof leafOutcomeRendererFailureSchema>;

/** @internal */
export const browserUiExtensionDescriptorSchema = v.pipe(
	recordSchema,
	v.object({
		/** @internal */
		extensionManifestId: v.string(),
		/** @internal */
		modulePath: v.string(),
		/** @internal */
		moduleUrl: v.string(),
		/** @internal */
		browserApiVersion: versionSchema,
	}),
);
/** @internal */
export type BrowserUiExtensionDescriptor = v.InferOutput<typeof browserUiExtensionDescriptorSchema>;
