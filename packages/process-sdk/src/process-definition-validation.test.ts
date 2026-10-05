import { describe, expect, it } from "vitest";
import {
	automaticTurn,
	type DefinedProcessInput,
	defineProcess,
	humanTurn,
	llmTurn,
	validateProcessDefinition,
} from "./define-process.js";
import { flow } from "./flow.js";

type Data = Record<string, never>;
const codec = { parse: (): Data => ({}), serialize: (value: Data) => value };

function declaration(
	turns: DefinedProcessInput<Data, Data>["turns"],
): DefinedProcessInput<Data, Data> {
	return {
		id: "validated_process",
		displayName: "Validated process",
		entry: Object.keys(turns)[0],
		paramsCodec: codec,
		stateCodec: codec,
		initialState: () => ({}),
		turns,
	};
}

function rejection(define: () => unknown): string {
	try {
		define();
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return error.message;
	}
	throw new Error("Expected definition to reject invalid declarations");
}

describe.each([
	{ name: "record", define: (input: DefinedProcessInput<Data, Data>) => defineProcess(input) },
	{
		name: "fluent",
		define(input: DefinedProcessInput<Data, Data>) {
			const builder = flow
				.process<Data, Data>(input.id)
				.displayName(input.displayName)
				.entry(input.entry)
				.codecs({ params: input.paramsCodec, state: input.stateCodec })
				.initialState(input.initialState);
			for (const [id, definition] of Object.entries(input.turns)) builder.turn({ id, definition });
			if (input.happyPath) builder.happyPath(...input.happyPath);
			return builder.define();
		},
	},
])("$name process definitions", ({ define }) => {
	it("collects independent declaration, routing, readiness, and product errors with context", () => {
		const input = declaration({
			invalid_parameter: llmTurn({
				description: "Invalid parameter",
				availableTools: [],
				branchType: "primary",
				context: "fresh",
				prompt: () => "Prompt",
				outcomes: {
					done: {
						description: "Done",
						parameters: { summary: { type: "string", description: "Summary", minimum: 1 } },
						complete: true,
					},
				},
			}),
			invalid_route: automaticTurn({
				description: "Invalid route",
				run: () => ({ outcome: "done", params: {} }),
				outcomes: {
					first: {
						description: "First",
						parameters: {},
						branches: { one: { to: "missing_first" }, two: { to: "missing_branch" } },
						choose: () => "one",
					},
					second: { description: "Second", parameters: {}, to: "missing_second" },
				},
			}),
			invalid_external_routes: humanTurn({
				description: "External routes",
				actions: { finish: { label: "Finish", acceptanceState: "accepted", complete: true } },
				externalActions: {
					first: { id: "first", source: { kind: "first" }, to: "missing_external_first" },
					second: { id: "second", source: { kind: "second" }, to: "missing_external_second" },
					ungated: { id: "ungated", source: { kind: "ungated" }, to: "consumer" },
				},
			}),
			consumer: llmTurn({
				description: "Consumer",
				availableTools: [],
				branchType: "primary",
				context: "fresh",
				prompt: () => "Prompt",
				optionalConsumedProducts: ["missing-product"],
				turnEnd: { outcome: "done", params: {}, complete: true },
			}),
		});
		const message = rejection(() => define(input));
		for (const reason of [
			/Process 'validated_process'.*turn 'invalid_parameter'.*minimum.*not a number/,
			/Process 'validated_process'.*turn 'invalid_route'.*unknown turn 'missing_first'/,
			/Process 'validated_process'.*turn 'invalid_route'.*unknown turn 'missing_second'/,
			/Process 'validated_process'.*turn 'invalid_route'.*unknown turn 'missing_branch'/,
			/Process 'validated_process'.*turn 'invalid_external_routes'.*unknown turn 'missing_external_first'/,
			/Process 'validated_process'.*turn 'invalid_external_routes'.*unknown turn 'missing_external_second'/,
			/Process 'validated_process'.*turn 'invalid_external_routes'.*worker turn 'consumer'.*requires .waitFor/,
			/Process 'validated_process'.*Turn 'consumer'.*'missing-product'.*never published/,
		])
			expect(message).toMatch(reason);
	});

	it("skips connectivity checks when a turn's completion declaration is invalid", () => {
		const input = declaration({
			start: llmTurn({
				description: "No completion",
				availableTools: [],
				branchType: "primary",
				context: "fresh",
				prompt: () => "Prompt",
			}),
			done: humanTurn({
				description: "Done",
				actions: { finish: { label: "Finish", acceptanceState: "accepted", complete: true } },
			}),
		});
		input.happyPath = ["start", "done"];
		const message = rejection(() => define(input));
		expect(message).toMatch(/start.*must declare at least one outcome tool or a turnEnd result/);
		expect(message).not.toContain("not connected");
	});

	it("rejects routing mutations that disconnect the declared happy path", () => {
		const start = llmTurn<Data, Data>({
			description: "Start",
			availableTools: [],
			branchType: "primary",
			context: "fresh",
			prompt: () => "Prompt",
			turnEnd: { outcome: "ready", params: {}, to: "done" },
		});
		const input = declaration({
			start,
			done: humanTurn({
				description: "Done",
				actions: { finish: { label: "Finish", acceptanceState: "accepted", complete: true } },
			}),
		});
		input.happyPath = ["start", "done"];
		const process = define(input);
		expect(validateProcessDefinition(process)).toEqual([]);

		start.turnEnd = { outcome: "ready", params: {}, complete: true };

		const disconnected = /happy path segment 'start' -> 'done' is not connected/;
		expect(validateProcessDefinition(process)).toEqual([expect.stringMatching(disconnected)]);
		expect(() => define(input)).toThrow(disconnected);
	});

	it("validates and revalidates mapped declarations without executing author callbacks", () => {
		const unexpected = (): never => {
			throw new Error("Author callback executed during validation");
		};
		const input = declaration({
			mapped: llmTurn({
				description: "Mapped",
				availableTools: [],
				branchType: "primary",
				context: "fresh",
				prompt: unexpected,
				waitFor: unexpected,
				prepare: unexpected,
				resolveIntegrationTools: unexpected,
				outcomes: { done: { description: "Done", parameters: {} } },
				forEach: {
					items: unexpected,
					key: unexpected,
					label: unexpected,
					itemCodec: { parse: unexpected, serialize: unexpected },
					resultCodec: { parse: unexpected, serialize: unexpected },
					yields: { done: unexpected },
					collect: unexpected,
					stateAfterSnapshot: unexpected,
					routing: { kind: "static", lifecycleStatus: "completed" },
				},
			}),
		});
		input.paramsCodec = input.stateCodec = { parse: unexpected, serialize: unexpected };
		input.initialState = unexpected;
		input.server = input.worker = unexpected;
		const process = define(input);
		expect(validateProcessDefinition(process)).toEqual([]);
	});
});
