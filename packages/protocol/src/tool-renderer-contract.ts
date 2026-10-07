/** @internal */
export const TOOL_CALL_RENDERER_VALUE_KINDS = ["markdown", "plaintext", "json"] as const;
/** @internal */
export type ToolCallRendererValueKind = (typeof TOOL_CALL_RENDERER_VALUE_KINDS)[number];

/** @internal */
export const TOOL_CALL_RENDERER_VALUE_SOURCES = ["arguments", "result"] as const;
/** @internal */
export type ToolCallRendererValueSource = (typeof TOOL_CALL_RENDERER_VALUE_SOURCES)[number];

/** @internal */
export interface ToolCallRendererFieldDefinition {
	/** @internal */
	id: string;
	/** @internal */
	label: string;
	/** @internal */
	kind: ToolCallRendererValueKind;
	/** @internal */
	source: ToolCallRendererValueSource;
	/** @internal */
	path?: string;
}

/** @internal */
export interface ToolCallRendererDefinition {
	/** @internal */
	toolName: string;
	/** @internal */
	title?: string;
	/** @internal */
	fields: readonly ToolCallRendererFieldDefinition[];
}

import * as v from "valibot";

const unknownRecordSchema = v.record(v.string(), v.unknown());

/** @internal */
export function readValueAtPath(value: unknown, path: string | undefined): unknown {
	if (!path || path.trim() === "") {
		return value;
	}
	let current: unknown = value;
	for (const segment of path
		.split(".")
		.map((part) => part.trim())
		.filter(Boolean)) {
		const parsedCurrent = v.safeParse(unknownRecordSchema, current);
		if (!parsedCurrent.success || !(segment in parsedCurrent.output)) {
			return undefined;
		}
		current = parsedCurrent.output[segment];
	}
	return current;
}
