import {
	TOOL_CALL_RENDERER_VALUE_KINDS,
	TOOL_CALL_RENDERER_VALUE_SOURCES,
	type ToolCallRendererDefinition,
	type ToolCallRendererFieldDefinition,
	type ToolCallRendererValueKind,
	type ToolCallRendererValueSource,
} from "@leitwerk-dev/protocol/tool-renderer-contract";
import type { TurnResultMarkdownBehavior } from "./types.js";

export {
	TOOL_CALL_RENDERER_VALUE_KINDS,
	TOOL_CALL_RENDERER_VALUE_SOURCES,
	type ToolCallRendererDefinition,
	type ToolCallRendererFieldDefinition,
	type ToolCallRendererValueKind,
	type ToolCallRendererValueSource,
};

export const MARKDOWN_RESULT_TOOL_NAME = "markdown_result";
export const MARKDOWN_RESULT_TOOL_MARKDOWN_PATH = "markdown";

export const MARKDOWN_RESULT_TOOL_RENDERER: ToolCallRendererDefinition = {
	toolName: MARKDOWN_RESULT_TOOL_NAME,
	title: "Markdown result",
	fields: [
		{
			id: "markdown",
			label: "Rendered markdown",
			kind: "markdown",
			source: "arguments",
			path: MARKDOWN_RESULT_TOOL_MARKDOWN_PATH,
		},
	],
};

export const CORE_TOOL_CALL_RENDERERS: readonly ToolCallRendererDefinition[] = [
	MARKDOWN_RESULT_TOOL_RENDERER,
];

export const REQUIRED_MARKDOWN_RESULT_TURN_RESULT: TurnResultMarkdownBehavior = {
	mode: "tool_call",
	toolName: MARKDOWN_RESULT_TOOL_NAME,
	path: MARKDOWN_RESULT_TOOL_MARKDOWN_PATH,
	required: true,
};

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

export function validateToolCallRendererDefinition(def: ToolCallRendererDefinition): string[] {
	const errors: string[] = [];
	if (!isNonEmptyString(def.toolName)) {
		errors.push("Tool renderer must declare a non-empty toolName");
	}
	if (!Array.isArray(def.fields) || def.fields.length === 0) {
		errors.push(`Tool renderer '${def.toolName}' must declare at least one field`);
		return errors;
	}
	const fieldIds = new Set<string>();
	for (const field of def.fields) {
		if (!isNonEmptyString(field.id)) {
			errors.push(`Tool renderer '${def.toolName}' contains a field with an empty id`);
		}
		if (fieldIds.has(field.id)) {
			errors.push(`Tool renderer '${def.toolName}' contains duplicate field id '${field.id}'`);
		}
		fieldIds.add(field.id);
		if (!isNonEmptyString(field.label)) {
			errors.push(
				`Tool renderer '${def.toolName}' field '${field.id}' must declare a non-empty label`,
			);
		}
		if (!TOOL_CALL_RENDERER_VALUE_KINDS.includes(field.kind)) {
			errors.push(
				`Tool renderer '${def.toolName}' field '${field.id}' uses unknown kind '${String(field.kind)}'`,
			);
		}
		if (!TOOL_CALL_RENDERER_VALUE_SOURCES.includes(field.source)) {
			errors.push(
				`Tool renderer '${def.toolName}' field '${field.id}' uses unknown source '${String(field.source)}'`,
			);
		}
		if (field.path !== undefined && !isNonEmptyString(field.path)) {
			errors.push(
				`Tool renderer '${def.toolName}' field '${field.id}' path must be non-empty when provided`,
			);
		}
	}
	return errors;
}
