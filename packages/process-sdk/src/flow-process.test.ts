import { describe, expect, it, vi } from "vitest";
import { emptyParamsCodec } from "./codecs.js";
import { flow } from "./flow.js";

const stateCodec = { parse: () => ({}), serialize: (value: Record<string, never>) => value };

function publishingTurn() {
	return flow
		.llm("publish_plan")
		.description("Publish plan")
		.buildPrompt(() => "Plan")
		.publish("plan")
		.to("consume_plan");
}

function consumingTurn() {
	return flow
		.llm("consume_plan")
		.description("Consume plan")
		.consume("plan")
		.outcomeTool("done", (tool) => tool.description("Done").complete())
		.buildPrompt((ctx) => ctx.input.plan);
}

function processBuilder() {
	return flow
		.process("test_process")
		.displayName("Test Process")
		.entry("publish_plan")
		.codecs({ params: emptyParamsCodec, state: stateCodec })
		.initialState(() => ({}));
}

describe("flow process composition", () => {
	it("fails fast on duplicate fragment turn ids", () => {
		const fragmentA = flow.fragment("a").turn(publishingTurn());
		const fragmentB = flow.fragment("b").turn(publishingTurn());

		expect(() => processBuilder().use(fragmentA).use(fragmentB).define()).toThrow(
			/duplicate turn 'publish_plan'/,
		);
	});

	it("publishes repository credential requirements without post-build mutation", () => {
		const process = processBuilder()
			.repositoryCredentials(() => [
				{ projectKey: "repo", kind: "git_ssh", credentialRef: "default" },
			])
			.turn(publishingTurn())
			.turn(consumingTurn())
			.define();

		expect(process.repositoryCredentials?.({ params: {}, projects: [] })).toEqual([
			{ projectKey: "repo", kind: "git_ssh", credentialRef: "default" },
		]);
	});

	it("preserves the server-side storage resolver without invoking it during definition", () => {
		const resolver = vi.fn(() => "50Gi");
		const process = processBuilder()
			.resolveStorageSize(resolver)
			.turn(publishingTurn())
			.turn(consumingTurn())
			.define();

		expect(resolver).not.toHaveBeenCalled();
		expect(process.resolveStorageSize).toBe(resolver);
	});

	it("delegates to defineProcess and composes fragment turns", () => {
		const fragment = flow.fragment("plan").turn(publishingTurn()).turn(consumingTurn());

		const process = processBuilder().use(fragment).define();

		expect(process).toMatchObject({
			id: "test_process",
			displayName: "Test Process",
			entryTurnId: "publish_plan",
			alternateEntryTurnIds: [],
		});
		expect([...process.turns.keys()].sort()).toEqual(["consume_plan", "publish_plan"]);
		expect(process.worker).toBeDefined();
		expect(process.server).toBeDefined();
	});

	it("declares alternate launch entries without changing the primary entry", () => {
		const process = processBuilder()
			.alternateEntry("consume_plan")
			.turn(publishingTurn())
			.turn(consumingTurn())
			.define();

		expect(process.entryTurnId).toBe("publish_plan");
		expect(process.alternateEntryTurnIds).toEqual(["consume_plan"]);
	});
});
