import { describe, expect, it } from "vitest";
import { buildInspectorPath, type InspectorTarget, readInspectorTarget } from "./router-logic.js";

describe("inspector routes", () => {
	it.each<InspectorTarget>([
		{ scope: "process", section: "overview" },
		{ scope: "process", section: "context-map", turnRecordId: "execution / 1" },
		{ scope: "step", turnId: "review plan" },
		{
			scope: "execution",
			turnRecordId: "execution / 1",
			section: "trace",
			entryId: "middle / 2",
			boundaryFor: "child",
		},
		{ scope: "execution", turnRecordId: "a", section: "context" },
		{ scope: "execution", turnRecordId: "a", section: "configuration" },
		{ scope: "execution", turnRecordId: "a", section: "trace", itemId: "event:27" },
	])("round trips a semantic target: %j", (target) => {
		expect(readInspectorTarget(buildInspectorPath("run", target))).toEqual(target);
	});
	it.each([
		"?inspect=execution",
		"?inspect=step",
		"?inspect=execution&turnRecordId=a&section=unknown",
		"?inspect=process&section=trace",
		"?inspect=unknown",
	])("does not silently replace invalid targets: %s", (query) => {
		expect(readInspectorTarget(`/processes/run${query}`)?.scope).toBe("invalid");
	});
	it("maps legacy reasoning links into the inspector without selecting a latest execution", () => {
		expect(readInspectorTarget("/processes/run?overlay=reasoning&turnRecordId=old")).toEqual({
			scope: "execution",
			turnRecordId: "old",
			section: "trace",
		});
		expect(readInspectorTarget("/processes/run?overlay=reasoning")?.scope).toBe("invalid");
		expect(readInspectorTarget("/processes/run")).toBeNull();
	});
});
