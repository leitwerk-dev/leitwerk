import { isUnknownRecord } from "@leitwerk-dev/domain";
import * as v from "valibot";

// Wire shape only; the catalog validates manifests and hosts check supported versions.
const recordSchema = v.custom<Record<string, unknown>>(isUnknownRecord);
const versionSchema = v.custom<number>((value) => typeof value === "number");

export const leafOutcomeRendererDescriptorSchema = v.pipe(
	recordSchema,
	v.object({
		ok: v.literal(true),
		rendererId: v.string(),
		kind: v.literal("custom_element"),
		tagName: v.string(),
		modulePath: v.string(),
		rendererApiVersion: versionSchema,
		extensionManifestId: v.string(),
		moduleUrl: v.string(),
	}),
);
export type LeafOutcomeRendererDescriptor = v.InferOutput<
	typeof leafOutcomeRendererDescriptorSchema
>;

export const leafOutcomeRendererFailureSchema = v.pipe(
	recordSchema,
	v.object({
		ok: v.literal(false),
		rendererId: v.string(),
		code: v.string(),
		message: v.string(),
	}),
);
export type LeafOutcomeRendererFailure = v.InferOutput<typeof leafOutcomeRendererFailureSchema>;

export const browserUiExtensionDescriptorSchema = v.pipe(
	recordSchema,
	v.object({
		extensionManifestId: v.string(),
		modulePath: v.string(),
		moduleUrl: v.string(),
		browserApiVersion: versionSchema,
	}),
);
export type BrowserUiExtensionDescriptor = v.InferOutput<typeof browserUiExtensionDescriptorSchema>;
