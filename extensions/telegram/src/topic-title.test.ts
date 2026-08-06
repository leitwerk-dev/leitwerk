import { createTestProcessInstance } from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it } from "vitest";
import { buildTopicTitle } from "./topic-title.js";

describe("buildTopicTitle", () => {
	it("uses the process title and short id", () => {
		const process = createTestProcessInstance({ id: "agt_123456789", title: " My process " });
		expect(buildTopicTitle({ process, template: "{title} · {shortId}" })).toContain("My process");
		expect(buildTopicTitle({ process, template: "{title} · {shortId}" })).toContain("3456789");
	});

	it("falls back to process identifiers and strips control characters", () => {
		const process = createTestProcessInstance({ title: null, externalId: "A\nB" });
		expect(buildTopicTitle({ process, template: "{title}" })).toBe("A B");
	});

	it("truncates long topic names", () => {
		const process = createTestProcessInstance({ title: "x".repeat(200) });
		expect(buildTopicTitle({ process, template: "{title}" }).length).toBeLessThanOrEqual(128);
	});
});
