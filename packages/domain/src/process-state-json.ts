import {
	createEmptyProcessProductRefs,
	createEmptyProcessSemanticEntryRefs,
	isValidProcessProductName,
	type ProcessProductRefs,
	type ProcessSemanticEntryRefs,
	parseProcessSemanticEntryRefs,
	parseSemanticEntryRef,
} from "./semantic-entry-refs.js";

/** @internal */
export interface ProcessStateJsonParseContext {
	/** @internal */
	label?: string;
	/** @internal */
	processId?: string;
}

function formatMalformedSubject(
	defaultLabel: string,
	context: string | ProcessStateJsonParseContext | undefined,
): string {
	if (typeof context === "string") {
		return context;
	}
	const label = context?.label ?? defaultLabel;
	return context?.processId ? `${label} for process '${context.processId}'` : label;
}

/** @internal */
export function parseProcessStateJsonStrict(
	stateJson: string | null | undefined,
	context?: string | ProcessStateJsonParseContext,
): Record<string, unknown> {
	if (!stateJson) {
		return {};
	}
	const subject = formatMalformedSubject("stateJson", context);
	let parsed: unknown;
	try {
		parsed = JSON.parse(stateJson);
	} catch (error) {
		throw new Error(
			`Malformed ${subject}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Malformed ${subject}: expected a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

/** @internal */
export function parseProcessStateJsonLenient(
	stateJson: string | null | undefined,
): Record<string, unknown> {
	try {
		return parseProcessStateJsonStrict(stateJson);
	} catch {
		return {};
	}
}

/** @internal */
export function parseSemanticEntryRefsStrict(
	value: unknown,
	context?: ProcessStateJsonParseContext,
): ProcessSemanticEntryRefs {
	if (value === undefined) {
		return createEmptyProcessSemanticEntryRefs();
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(
			`Malformed ${formatMalformedSubject("semanticEntryRefs", {
				label: "semanticEntryRefs",
				processId: context?.processId,
			})}: expected an object when present`,
		);
	}
	return parseProcessSemanticEntryRefs(value);
}

/** @internal */
export function parseSemanticEntryRefsLenient(value: unknown): ProcessSemanticEntryRefs {
	try {
		return parseSemanticEntryRefsStrict(value);
	} catch {
		return createEmptyProcessSemanticEntryRefs();
	}
}

/** @internal */
export function parseProductRefsStrict(
	value: unknown,
	context?: ProcessStateJsonParseContext,
): ProcessProductRefs {
	if (value === undefined) {
		return createEmptyProcessProductRefs();
	}
	const subject = formatMalformedSubject("productRefs", {
		label: "productRefs",
		processId: context?.processId,
	});
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Malformed ${subject}: expected an object when present`);
	}
	const refs: ProcessProductRefs = {};
	for (const [name, rawRef] of Object.entries(value as Record<string, unknown>)) {
		if (!isValidProcessProductName(name)) {
			throw new Error(`Malformed ${subject}: invalid product name '${name}'`);
		}
		const ref = parseSemanticEntryRef(rawRef);
		if (!ref) {
			throw new Error(`Malformed ${subject}: product '${name}' must reference an entry`);
		}
		refs[name] = ref;
	}
	return refs;
}

/** @internal */
export function parseProductRefsLenient(value: unknown): ProcessProductRefs {
	try {
		return parseProductRefsStrict(value);
	} catch {
		return createEmptyProcessProductRefs();
	}
}

/** @internal */
export function parseSemanticEntryRefsFromStateJsonStrict(
	stateJson: string | null | undefined,
	context?: string | ProcessStateJsonParseContext,
): ProcessSemanticEntryRefs {
	const stateRecord = parseProcessStateJsonStrict(stateJson, context);
	return parseSemanticEntryRefsStrict(
		stateRecord.semanticEntryRefs,
		typeof context === "string" ? undefined : context,
	);
}

/** @internal */
export function parseSemanticEntryRefsFromStateJsonLenient(
	stateJson: string | null | undefined,
): ProcessSemanticEntryRefs {
	const stateRecord = parseProcessStateJsonLenient(stateJson);
	return parseSemanticEntryRefsLenient(stateRecord.semanticEntryRefs);
}

/** @internal */
export function parseProductRefsFromStateJsonStrict(
	stateJson: string | null | undefined,
	context?: string | ProcessStateJsonParseContext,
): ProcessProductRefs {
	const stateRecord = parseProcessStateJsonStrict(stateJson, context);
	return parseProductRefsStrict(
		stateRecord.productRefs,
		typeof context === "string" ? undefined : context,
	);
}

/** @internal */
export function parseProductRefsFromStateJsonLenient(
	stateJson: string | null | undefined,
): ProcessProductRefs {
	const stateRecord = parseProcessStateJsonLenient(stateJson);
	return parseProductRefsLenient(stateRecord.productRefs);
}
