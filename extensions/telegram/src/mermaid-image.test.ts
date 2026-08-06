import { describe, expect, it } from "vitest";
import { renderMermaidPng } from "./mermaid-image.js";

describe("renderMermaidPng", () => {
	it("rejects invalid, empty, and over-complex Mermaid source", async () => {
		await expect(renderMermaidPng("not-a-diagram <broken>")).rejects.toThrow();
		await expect(renderMermaidPng("  ")).rejects.toThrow("empty");
		await expect(
			renderMermaidPng(Array.from({ length: 501 }, () => "A --> B").join("\n")),
		).rejects.toThrow("500 lines");
	});
});
