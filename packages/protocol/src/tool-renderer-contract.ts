export const TOOL_CALL_RENDERER_VALUE_KINDS = ["markdown", "plaintext", "json"] as const;
export type ToolCallRendererValueKind = (typeof TOOL_CALL_RENDERER_VALUE_KINDS)[number];

export const TOOL_CALL_RENDERER_VALUE_SOURCES = ["arguments", "result"] as const;
export type ToolCallRendererValueSource = (typeof TOOL_CALL_RENDERER_VALUE_SOURCES)[number];

export interface ToolCallRendererFieldDefinition {
	id: string;
	label: string;
	kind: ToolCallRendererValueKind;
	source: ToolCallRendererValueSource;
	path?: string;
}

export interface ToolCallRendererDefinition {
	toolName: string;
	title?: string;
	fields: readonly ToolCallRendererFieldDefinition[];
}

import * as v from "valibot";

const unknownRecordSchema = v.record(v.string(), v.unknown());

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
