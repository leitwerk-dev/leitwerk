import { describe, expect, it } from "vitest";
import { flow } from "./flow.js";
import { applyOutcomeContract, resolveOutcomeContract } from "./outcome-contract.js";
import {
	assertOutcomeSchema,
	compileOutcomeParameters,
	validateOutcomeParameters,
	validateOutcomeValue,
} from "./outcome-schema.js";
import type { OutcomeToolArrayItemSpec } from "./types.js";

const variant = (
	tag: string,
	properties: Record<string, OutcomeToolArrayItemSpec> = {},
): OutcomeToolArrayItemSpec => ({
	type: "object",
	properties: { kind: { type: "string", enum: [tag] }, ...properties },
	required: ["kind", ...Object.keys(properties)],
	additionalProperties: false,
});
const choice = {
	anyOf: [variant("write", { text: { type: "string", minLength: 1 } }), variant("skip")],
};
const parameters = { action: { ...choice, description: "Action", required: true } };

describe("shared outcome schemas", () => {
	it("preserves native nested anyOf and reports errors from the selected branch", () => {
		expect(compileOutcomeParameters(parameters, true).properties!.action).toMatchObject(choice);
		expect(
			validateOutcomeParameters(parameters, { action: { kind: "write", text: "Hello" } }),
		).toEqual([]);
		expect(validateOutcomeParameters(parameters, { action: { kind: "skip" } })).toEqual([]);
		expect(validateOutcomeParameters(parameters, { action: { kind: "write" } })).toMatchObject([
			{ path: "action.text", code: "invalid_action" },
		]);
		expect(
			validateOutcomeParameters(parameters, { action: { kind: "skip", text: "placeholder" } }),
		).toMatchObject([{ path: "action.text", code: "invalid_action" }]);
		expect(
			validateOutcomeParameters(parameters, { action: { kind: "unknown" } })[0].message,
		).toContain("choose write, skip");
	});

	it("supports scalar, array, property, and overlapping alternatives", () => {
		const schema: OutcomeToolArrayItemSpec = {
			type: "array",
			items: {
				anyOf: [
					{ type: "number", minimum: 0 },
					{ type: "string" },
					{ type: "array", items: choice },
					{ type: "object", properties: { value: choice } },
				],
			},
		};
		assertOutcomeSchema(schema);
		expect(
			validateOutcomeValue(schema, [
				1,
				"one",
				[{ kind: "skip" }],
				{ value: { kind: "write", text: "ok" } },
			]),
		).toEqual([]);
		expect(validateOutcomeValue(schema, [-1])[0].path).toBe("arguments[0]");
		expect(
			validateOutcomeValue(
				{ anyOf: [{ type: "string" }, { type: "string", minLength: 2 }] },
				"word",
			),
		).toEqual([]);
	});

	it.each([
		{ anyOf: [] },
		{ anyOf: [{ type: "invalid" }] },
		{ type: "object", anyOf: [{ type: "string" }] },
		{ type: "array" },
		{ type: "object", required: ["missing"] },
	])("rejects malformed declaration %j", (schema) => {
		expect(() => assertOutcomeSchema(schema as OutcomeToolArrayItemSpec)).toThrow();
	});

	it("rejects optional or open strict objects without rewriting authored semantics", () => {
		expect(() =>
			compileOutcomeParameters({ action: { ...parameters.action, required: false } }, true),
		).toThrow("strict schemas require");
		expect(() =>
			assertOutcomeSchema({ anyOf: [variant("closed"), { type: "object" }] }, true),
		).toThrow("strict schemas require");
		expect(() =>
			compileOutcomeParameters({ action: { ...parameters.action, required: false } }),
		).not.toThrow();
	});

	it("separates array presence from cardinality and preserves explicit error codes", () => {
		const specs = {
			changes: { type: "array" as const, items: choice, required: true, description: "Changes" },
		};
		expect(validateOutcomeParameters(specs, { changes: [] })).toEqual([]);
		expect(
			validateOutcomeParameters(
				{ changes: { ...specs.changes, minItems: 1 } },
				{ changes: [{ kind: "skip" }] },
			),
		).toEqual([]);
		expect(validateOutcomeParameters(specs, {})).toMatchObject([{ code: "changes_required" }]);
		expect(
			validateOutcomeParameters(
				{ changes: { ...specs.changes, minItems: 1, minItemsErrorCode: "empty_changes" } },
				{ changes: [] },
			),
		).toMatchObject([{ code: "empty_changes" }]);
		expect(
			validateOutcomeParameters(
				{
					count: {
						type: "number",
						description: "Count",
						minimum: 2,
						minimumErrorCode: "too_small",
					},
				},
				{ count: 1 },
			),
		).toMatchObject([{ code: "too_small" }]);
	});
});

it("freezes contextual contracts, including Markdown, while new starts resolve current state", () => {
	const turn = flow
		.llm<{}, { canWrite: boolean }>("choose")
		.description("Choose an action")
		.prompt(() => "Choose")
		.outcomeTool("done", (outcome) =>
			outcome
				.description("Decide")
				.union("action", choice.anyOf, { required: true })
				.resolveParameters(({ state }) => ({
					action: {
						...parameters.action,
						anyOf: state.canWrite ? choice.anyOf : [variant("skip")],
					},
				}))
				.strictSchema()
				.complete(),
		).definition;
	const frozen = resolveOutcomeContract(turn, { params: {}, state: { canWrite: false } });
	const replacement = applyOutcomeContract(turn, JSON.parse(JSON.stringify(frozen)));
	expect(
		validateOutcomeParameters(replacement.outcomes!.done!.parameters, {
			action: { kind: "write", text: "ok" },
		}),
	).not.toEqual([]);
	const fresh = resolveOutcomeContract(turn, { params: {}, state: { canWrite: true } });
	expect(
		validateOutcomeParameters(fresh.outcomes.done.parameters, {
			action: { kind: "write", text: "ok" },
		}),
	).toEqual([]);
	expect(frozen.outcomes.done.strictSchema).toBe(true);
	expect(frozen.turnResultMarkdown).toEqual(turn.turnResultMarkdown);
});
