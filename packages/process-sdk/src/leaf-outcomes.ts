import * as v from "valibot";
import type { LeafOutcomeCaptureResult, ProcessLeafOutcomeDefinition } from "./extension-api.js";

const unknownRecordSchema = v.pipe(
	v.unknown(),
	v.check(
		(value) => typeof value === "object" && value !== null && !Array.isArray(value),
		"Expected object",
	),
	v.record(v.string(), v.unknown()),
);

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

export function validateProcessLeafOutcomeDefinition(def: ProcessLeafOutcomeDefinition): string[] {
	const errors: string[] = [];
	if (!isNonEmptyString(def.rendererId)) {
		errors.push("Leaf outcome definition must declare a non-empty rendererId");
	}
	if (typeof def.capture !== "function") {
		errors.push(`Leaf outcome '${String(def.rendererId)}' must declare a capture() function`);
	}
	return errors;
}

export function validateLeafOutcomeCaptureResult(
	result: unknown,
	expectedRendererId?: string,
): string[] {
	const errors: string[] = [];
	const parsedResult = v.safeParse(unknownRecordSchema, result);
	if (!parsedResult.success) {
		return ["Leaf outcome capture result must be an object"];
	}
	const captureResult = parsedResult.output;
	if (!isNonEmptyString(captureResult.rendererId)) {
		errors.push("Leaf outcome capture result must include a non-empty rendererId");
	} else if (expectedRendererId && captureResult.rendererId.trim() !== expectedRendererId.trim()) {
		errors.push(
			`Leaf outcome capture result rendererId '${captureResult.rendererId}' must match '${expectedRendererId}'`,
		);
	}
	if (!v.safeParse(unknownRecordSchema, captureResult.props).success) {
		errors.push("Leaf outcome capture result props must be an object");
	}
	if (
		captureResult.schemaVersion !== undefined &&
		(typeof captureResult.schemaVersion !== "number" ||
			!Number.isInteger(captureResult.schemaVersion))
	) {
		errors.push("Leaf outcome capture result schemaVersion must be an integer when provided");
	}
	if (
		captureResult.fallbackMarkdown !== undefined &&
		captureResult.fallbackMarkdown !== null &&
		typeof captureResult.fallbackMarkdown !== "string"
	) {
		errors.push("Leaf outcome capture result fallbackMarkdown must be a string or null");
	}
	return errors;
}

export function normalizeLeafOutcomeCaptureResult(
	result: LeafOutcomeCaptureResult,
): LeafOutcomeCaptureResult {
	return {
		rendererId: result.rendererId.trim(),
		...(result.schemaVersion !== undefined ? { schemaVersion: result.schemaVersion } : {}),
		props: { ...result.props },
		...(result.fallbackMarkdown !== undefined ? { fallbackMarkdown: result.fallbackMarkdown } : {}),
	};
}
