import { describe, expect, it } from "vitest";
import {
	escapeLeafOutcomeHtml,
	normalizeLeafOutcomeOptionalText,
} from "./leaf-outcome-renderer.js";

describe("leaf-outcome renderer helpers", () => {
	it("escapes HTML-sensitive characters", () => {
		expect(escapeLeafOutcomeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
	});

	it("normalizes optional text by trimming empty strings to null", () => {
		expect(normalizeLeafOutcomeOptionalText("  value  ")).toBe("value");
		expect(normalizeLeafOutcomeOptionalText("   ")).toBeNull();
		expect(normalizeLeafOutcomeOptionalText(null)).toBeNull();
	});
});
