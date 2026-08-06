import { type PrimaryPathToolCallSnapshot, readValueAtPath } from "@leitwerk-dev/protocol";
import type { ToolCallRendererDefinition, ToolCallRendererFieldDefinition } from "./api";

export interface ResolvedToolCallRendererField {
	id: string;
	label: string;
	kind: ToolCallRendererFieldDefinition["kind"];
	value: unknown;
}

function sourceValue(
	toolCall: Pick<PrimaryPathToolCallSnapshot, "arguments" | "result">,
	source: ToolCallRendererFieldDefinition["source"],
): unknown {
	return source === "arguments" ? toolCall.arguments : toolCall.result;
}

function normalizeRenderableValue(
	field: ToolCallRendererFieldDefinition,
	value: unknown,
): unknown | null {
	if (field.kind === "json") {
		return value === undefined ? null : value;
	}
	if (typeof value !== "string") {
		return null;
	}
	return value.trim() === "" ? null : value;
}

export function createToolRendererIndex(
	definitions: readonly ToolCallRendererDefinition[],
): Record<string, ToolCallRendererDefinition> {
	return Object.fromEntries(definitions.map((definition) => [definition.toolName, definition]));
}

export function resolveToolRenderer(
	index: Record<string, ToolCallRendererDefinition>,
	toolName: string,
): ToolCallRendererDefinition | null {
	return index[toolName] ?? null;
}

export function resolveToolRendererFields(
	toolCall: Pick<PrimaryPathToolCallSnapshot, "arguments" | "result">,
	renderer: ToolCallRendererDefinition | null | undefined,
): ResolvedToolCallRendererField[] {
	if (!renderer) {
		return [];
	}
	const resolved: ResolvedToolCallRendererField[] = [];
	for (const field of renderer.fields) {
		const rawValue = readValueAtPath(sourceValue(toolCall, field.source), field.path);
		const normalizedValue = normalizeRenderableValue(field, rawValue);
		if (normalizedValue === null) {
			continue;
		}
		resolved.push({
			id: field.id,
			label: field.label,
			kind: field.kind,
			value: normalizedValue,
		});
	}
	return resolved;
}
