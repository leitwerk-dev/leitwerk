import { describe, expect, it } from "vitest";
import {
	createToolRendererIndex,
	resolveToolRenderer,
	resolveToolRendererFields,
} from "./tool-call-rendering.js";

describe("tool-call-rendering", () => {
	const renderer = {
		toolName: "markdown_result",
		title: "Markdown result",
		fields: [
			{
				id: "markdown",
				label: "Rendered markdown",
				kind: "markdown" as const,
				source: "arguments" as const,
				path: "markdown",
			},
			{
				id: "meta",
				label: "Metadata",
				kind: "json" as const,
				source: "result" as const,
				path: "data",
			},
		],
	};

	it("indexes renderers by tool name", () => {
		const index = createToolRendererIndex([renderer]);
		expect(resolveToolRenderer(index, "markdown_result")).toEqual(renderer);
		expect(resolveToolRenderer(index, "missing")).toBeNull();
	});

	it("resolves renderer fields from nested argument and result paths", () => {
		expect(
			resolveToolRendererFields(
				{
					arguments: { markdown: "## Result\n\n- Ship it" },
					result: { data: { publicationCount: 1 } },
				},
				renderer,
			),
		).toEqual([
			{
				id: "markdown",
				label: "Rendered markdown",
				kind: "markdown",
				value: "## Result\n\n- Ship it",
			},
			{
				id: "meta",
				label: "Metadata",
				kind: "json",
				value: { publicationCount: 1 },
			},
		]);
	});

	it("skips missing or empty string fields", () => {
		expect(
			resolveToolRendererFields(
				{
					arguments: { markdown: "   " },
					result: null,
				},
				renderer,
			),
		).toEqual([]);
	});
});
