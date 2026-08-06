import {
	StubPiTreeHandleFactory,
	type StubToolCallScriptResolver,
	type StubToolCallScriptResolverContext,
} from "./stub-pi-tree-handle.js";

function isObjectLike(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

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

export function createSchemaDrivenToolCallScriptResolver(): StubToolCallScriptResolver {
	return ({ tools }: StubToolCallScriptResolverContext) => {
		const markdownTool = tools.find((tool) => tool.name === "markdown_result");
		const completionTool = tools.find(
			(tool) => tool.name !== "markdown_result" && tool.name !== "upload_result_images",
		);
		if (markdownTool && completionTool) {
			return {
				calls: [
					{
						toolName: markdownTool.name,
						args: synthesizeStubToolArgs(markdownTool.parameters),
					},
					{
						toolName: completionTool.name,
						args: synthesizeStubToolArgs(completionTool.parameters),
					},
				],
			};
		}
		const tool = markdownTool ?? completionTool ?? tools[0];
		if (!tool) {
			return undefined;
		}
		return {
			toolName: tool.name,
			args: synthesizeStubToolArgs(tool.parameters),
		};
	};
}

export function createSchemaDrivenStubPiFactory(
	options: { toolCallScriptResolver?: StubToolCallScriptResolver } = {},
): StubPiTreeHandleFactory {
	return new StubPiTreeHandleFactory({
		toolCallScriptResolver:
			options.toolCallScriptResolver ?? createSchemaDrivenToolCallScriptResolver(),
	});
}
