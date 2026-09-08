import { describe, expect, it } from "vitest";
import {
	automaticTurn,
	defineProcess,
	emptyParamsCodec,
	llmTurn,
	routeTurnOutcomes,
} from "./index.js";

const stateCodec = {
	parse: (value: unknown) => value as Record<string, unknown>,
	serialize: (value: Record<string, unknown>) => value,
};

describe("routeTurnOutcomes", () => {
	it("routes a base LLM turn while preserving outcome parameter schema", () => {
		const base = llmTurn({
			availableTools: [],
			description: "Base",
			branchType: "primary",
			context: "fresh",
			prompt: async () => "prompt",
			outcomes: {
				done: {
					description: "Done",
					parameters: { summary: { type: "string", description: "Summary", required: true } },
				},
			},
		});

		const routed = routeTurnOutcomes(base, { done: { to: "review" } });

		expect(routed.outcomes?.done?.parameters).toEqual(base.outcomes?.done?.parameters);
		expect(routed.outcomes?.done?.to).toBe("review");
	});

	it("routes an automatic turn while preserving run", async () => {
		const run = async () => ({ outcome: "done" as const, params: {} });
		const base = automaticTurn({
			description: "Auto",
			run,
			outcomes: { done: { description: "Done", parameters: {} } },
		});
		const routed = routeTurnOutcomes(base, { done: { complete: true } });

		expect(routed.run).toBe(run);
		expect(await routed.run({} as never)).toEqual({ outcome: "done", params: {} });
	});

	it("throws for unknown routed outcomes", () => {
		const base = llmTurn({
			availableTools: [],
			description: "Base",
			branchType: "primary",
			context: "fresh",
			prompt: async () => "prompt",
			outcomes: { done: { description: "Done", parameters: {} } },
		});

		expect(() => routeTurnOutcomes(base, { missing: { complete: true } })).toThrow(
			/unknown outcome/,
		);
	});

	it("throws in strict mode when a base outcome is not routed", () => {
		const base = llmTurn({
			availableTools: [],
			description: "Base",
			branchType: "primary",
			context: "fresh",
			prompt: async () => "prompt",
			outcomes: {
				done: { description: "Done", parameters: {} },
				retry: { description: "Retry", parameters: {} },
			},
		});

		expect(() => routeTurnOutcomes(base, { done: { complete: true } }, { strict: true })).toThrow(
			/omitted outcome/,
		);
	});

	it("applies route effects without replacing original validated parameters", async () => {
		const base = llmTurn<Record<string, never>, { ready: boolean }, "done">({
			description: "Base",
			branchType: "primary",
			context: "fresh",
			prompt: async () => "prompt",
			outcomes: {
				done: {
					description: "Done",
					parameters: { summary: { type: "string", description: "Summary", required: true } },
				},
			},
		});
		const routed = routeTurnOutcomes(base, {
			done: { complete: true, effect: ({ ctx }) => ({ state: { ...ctx.state, ready: true } }) },
		});
		defineProcess<Record<string, never>, { ready: boolean }>({
			id: "routing_test",
			displayName: "Routing Test",
			entry: "start",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({ ready: false }),
			turns: { start: routed },
		});

		const outcome = routed.outcomes?.done;
		expect(outcome?.parameters).toEqual(base.outcomes?.done?.parameters);
		expect(await outcome?.effect?.({ ctx: { state: { ready: false } } } as never)).toEqual({
			state: { ready: true },
		});
	});
});
