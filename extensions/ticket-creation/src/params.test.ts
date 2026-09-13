import { describe, expect, it } from "vitest";
import { ticketCreationParamsCodec as codec } from "./params.js";

const historical = {
	parentInstanceId: "parent-1",
	artifact: { kind: "turn_result", turnRecordId: "turn-1" },
	focus: { kind: "whole_result" },
	context: {
		focusedResult: "Result\n",
		parentPrompt: "Original prompt",
		durableResults: ["Earlier result"],
		additionalInstructions: "",
		capturedAt: "2026-09-13T12:00:00Z",
	},
	additionalInstructions: "",
	toolName: "local_create_ticket",
	initiatingActor: { id: "operator", kind: "user", provider: null },
};
describe("stored ticket parameters", () => {
	it.each([
		{},
		{
			ticketDestination: {
				summary: { id: "one", displayName: "Notebook" },
				data: { opaque: [null, true, "adapter-owned", 4] },
			},
		},
		{
			ticketDestinations: [{ id: "one", displayName: "Notebook", group: "Local", description: "" }],
			ticketDestinationWarnings: ["Offline destination omitted"],
		},
	])("preserves historical destination shape %j and detached parent material", (destinations) => {
		const raw = structuredClone({ ...historical, ...destinations });
		const result = codec.parse(raw);
		expect(result).toEqual(raw);
		raw.context.durableResults.push("Later result");
		expect(result.context.durableResults).toEqual(["Earlier result"]);
		expect(codec.parse(codec.serialize(result))).toEqual(result);
	});
	it.each([
		null,
		"opaque",
		12,
		["opaque", { id: 1 }],
	])("leaves valid destination data opaque: %j", (data) => {
		expect(
			codec.parse({
				...historical,
				ticketDestination: { summary: { id: "x", displayName: "X" }, data },
			}).ticketDestination?.data,
		).toEqual(data);
	});
	it("accepts leaf artifacts and excerpt focus", () => {
		expect(
			codec.parse({
				...historical,
				artifact: { kind: "leaf_outcome", leafEntryId: "leaf-1" },
				focus: { kind: "excerpt", excerpt: "Result" },
			}).artifact,
		).toEqual({ kind: "leaf_outcome", leafEntryId: "leaf-1" });
	});
	it.each([
		{ context: { ...historical.context, parentPrompt: 5 } },
		{ context: { ...historical.context, durableResults: ["valid", 3] } },
		{ context: { ...historical.context, capturedAt: null } },
		{ context: { ...historical.context, additionalInstructions: [] } },
		{ artifact: { kind: "turn_result" } },
		{ artifact: { kind: "leaf_outcome", leafEntryId: "" } },
		{ artifact: { kind: "unknown", turnRecordId: "turn" } },
		{ focus: { kind: "excerpt" } },
		{ focus: { kind: "excerpt", excerpt: " " } },
		{ focus: { kind: "whole_result", excerpt: false } },
		{ initiatingActor: null },
		{ initiatingActor: { id: "operator", kind: 2, provider: null } },
		{ initiatingActor: { id: "operator", kind: "user", provider: 3 } },
		{ initiatingActor: { id: "operator", kind: "user", provider: null, displayName: {} } },
		{ ticketDestinations: {} },
		{ ticketDestinations: [{ id: "one" }] },
		{ ticketDestination: { summary: { id: "one", displayName: "One", group: 4 }, data: null } },
		{ ticketDestination: { summary: { id: "one", displayName: "One" } } },
		{
			ticketDestination: { summary: { id: "one", displayName: "One" }, data: { value: undefined } },
		},
		{ ticketDestination: { summary: { id: "one", displayName: "One" }, data: NaN } },
		{
			ticketDestination: {
				summary: { id: "one", displayName: "One" },
				data: null,
				agentContext: [],
			},
		},
		{ ticketDestinationWarnings: ["valid", false] },
		{ launchModelProfileId: 5 },
		{ additionalInstructions: null },
	])("rejects malformed nested input %j", (patch) => {
		expect(() => codec.parse({ ...historical, ...patch })).toThrow();
	});
	it("rejects cyclic adapter data", () => {
		const data: Record<string, unknown> = {};
		data.self = data;
		expect(() =>
			codec.parse({
				...historical,
				ticketDestination: { summary: { id: "one", displayName: "One" }, data },
			}),
		).toThrow(/JSON-serializable/);
	});
});
