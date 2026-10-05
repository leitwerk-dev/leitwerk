import { describe, expect, it } from "vitest";
import { emptyParamsCodec } from "./codecs.js";
import { flow } from "./flow.js";

describe("turn readiness definitions", () => {
	it("keeps an ordinary LLM turn to a literal prompt", async () => {
		const turn = flow
			.llm("write")
			.description("Write")
			.prompt("Write a short poem.")
			.end("done")
			.complete().definition;
		expect(turn.waitFor).toBeUndefined();
		expect(await turn.prompt({} as never)).toBe("Write a short poem.");
	});

	it.each([
		"llm",
		"mapped",
		"automatic",
	] as const)("rejects an external edge to an ungated %s turn", (kind) => {
		const build = (gated: boolean) => {
			const llm = flow.llm("work").description("Work").prompt("Work.");
			const automatic = flow
				.automatic("work")
				.description("Work")
				.run(async () => ({ outcome: "done", params: {} }))
				.outcome("done", (o) => o.description("Done").complete());
			const mapped = flow
				.mappedLlm("work", {
					items: () => [{}],
					itemCodec: emptyParamsCodec,
					resultCodec: emptyParamsCodec,
					key: () => "one",
				})
				.description("Work")
				.prompt("Work.")
				.outcomeTool("done", (outcome) => outcome.description("Done").yield(() => ({})));
			if (gated) {
				llm.waitFor(() => false);
				mapped.waitFor(() => false);
				automatic.waitFor(() => false);
			}
			const worker =
				kind === "llm"
					? llm.end("done").complete()
					: kind === "mapped"
						? mapped.collect(({ state }) => state).complete()
						: automatic;
			return flow
				.process("external_readiness")
				.displayName("Readiness")
				.entry("event")
				.codecs({ params: emptyParamsCodec, state: emptyParamsCodec })
				.initialState(() => ({}))
				.turn(
					flow
						.external("event")
						.description("Event")
						.from({ kind: "test.event", config: {} })
						.to("work"),
				)
				.turn(worker)
				.define();
		};
		expect(() => build(false)).toThrow(/requires .waitFor/);
		expect(() => build(true)).not.toThrow();
	});
});
