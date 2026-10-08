import { describe, expect, it } from "vitest";
import {
	createSchemaDrivenToolCallScriptResolver,
	synthesizeStubArgValue,
	synthesizeStubToolArgs,
} from "./schema-driven-stub-pi.js";

describe("schema-driven stub Pi helpers", () => {
	it("synthesizes scalar, object, array, and special-case values", () => {
		expect(synthesizeStubArgValue("count", { type: "number" })).toBe(1);
		expect(synthesizeStubArgValue("flag", { type: "boolean" })).toBe(true);
		expect(synthesizeStubArgValue("config", { type: "object" })).toEqual({});
		expect(synthesizeStubArgValue("items", { type: "array", items: { type: "integer" } })).toEqual([
			1,
		]);
		expect(synthesizeStubArgValue("title", { type: "string" })).toBe("title value");
		expect(synthesizeStubArgValue("changedProjects", { type: "array" })).toBeUndefined();
	});

	it("synthesizes arguments from object-schema properties", () => {
		expect(
			synthesizeStubToolArgs({
				type: "object",
				properties: {
					summary: { type: "string" },
					count: { type: "integer" },
					flags: { type: "array", items: { type: "boolean" } },
				},
			}),
		).toEqual({
			summary: "summary value",
			count: 1,
			flags: [true],
		});
	});

	it("emits markdown_result before the completion tool when both are available", () => {
		const resolver = createSchemaDrivenToolCallScriptResolver();
		const result = resolver({
			tools: [
				{
					name: "abort_turn",
					parameters: { reason: { type: "string" } },
				},
				{
					name: "complete_turn",
					parameters: { summary: { type: "string" } },
				},
				{
					name: "markdown_result",
					parameters: { markdown: { type: "string" } },
				},
			],
		});

		expect(result).toEqual({
			calls: [
				{ toolName: "markdown_result", args: { markdown: "markdown value" } },
				{ toolName: "complete_turn", args: { summary: "summary value" } },
			],
		});
	});

	it("returns a single synthesized call when only one tool is available", () => {
		const resolver = createSchemaDrivenToolCallScriptResolver();
		expect(
			resolver({
				tools: [{ name: "plan_saved", parameters: { summary: { type: "string" } } }],
			}),
		).toEqual({
			toolName: "plan_saved",
			args: { summary: "summary value" },
		});
	});

	it("does not select abort_turn when only framework tools are available", () => {
		const resolver = createSchemaDrivenToolCallScriptResolver();
		const abortTool = { name: "abort_turn", parameters: { reason: { type: "string" } } };
		expect(resolver({ tools: [abortTool] })).toBeUndefined();
		expect(
			resolver({
				tools: [
					abortTool,
					{ name: "markdown_result", parameters: { markdown: { type: "string" } } },
				],
			}),
		).toEqual({ toolName: "markdown_result", args: { markdown: "markdown value" } });
	});

	it("returns undefined when no tools are available", () => {
		const resolver = createSchemaDrivenToolCallScriptResolver();
		expect(resolver({ tools: [] })).toBeUndefined();
	});
});
