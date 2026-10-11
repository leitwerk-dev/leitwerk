import {
	StubPiTreeHandleFactory,
	type StubToolCallScriptResolver,
	type StubToolCallScriptResolverContext,
} from "./stub-pi-tree-handle.js";

function isObjectLike(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** @internal */
export function synthesizeStubArgValue(key: string, spec: unknown): unknown {
	if (key === "changedProjects") {
		return undefined;
	}
	const type = isObjectLike(spec) && typeof spec.type === "string" ? spec.type : "string";
	switch (type) {
		case "number":
		case "integer":
			return 1;
		case "boolean":
			return true;
		case "array": {
			const itemSpec = isObjectLike(spec) ? spec.items : undefined;
			return [synthesizeStubArgValue(`${key}_item`, itemSpec)];
		}
		case "object":
			return {};
		default:
			return `${key} value`;
	}
}

/** @internal */
export function synthesizeStubToolArgs(
	parameters: Record<string, unknown>,
): Record<string, unknown> {
	const parameterEntries =
		isObjectLike(parameters) && parameters.type === "object" && isObjectLike(parameters.properties)
			? Object.entries(parameters.properties)
			: Object.entries(parameters);
	return Object.fromEntries(
		parameterEntries.map(([key, spec]) => [key, synthesizeStubArgValue(key, spec)]),
	);
}

/** @internal */
export function createSchemaDrivenToolCallScriptResolver(): StubToolCallScriptResolver {
	return ({ tools: availableTools }: StubToolCallScriptResolverContext) => {
		// Failure requires an explicit script; the default stub completes successful turns.
		const tools = availableTools.filter((tool) => tool.name !== "abort_turn");
		const markdownTool = tools.find((tool) => tool.name === "markdown_result");
		const completionTool = tools.find(
			(tool) => tool.name !== "markdown_result" && tool.name !== "upload_result_images",
		);
		const selectedTools =
			markdownTool && completionTool
				? [markdownTool, completionTool]
				: [markdownTool ?? completionTool ?? tools[0]];
		const calls = selectedTools
			.filter((tool) => tool !== undefined)
			.map((tool) => ({ toolName: tool.name, args: synthesizeStubToolArgs(tool.parameters) }));
		return calls.length > 1 ? { calls } : calls[0];
	};
}

/** @internal */
export function createSchemaDrivenStubPiFactory(
	options: {
		/** @internal */
		toolCallScriptResolver?: StubToolCallScriptResolver;
	} = {},
): StubPiTreeHandleFactory {
	return new StubPiTreeHandleFactory({
		toolCallScriptResolver:
			options.toolCallScriptResolver ?? createSchemaDrivenToolCallScriptResolver(),
	});
}
