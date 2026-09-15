import { describe, expect, it } from "vitest";
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

describe("flow process composition", () => {
	it("fails fast on duplicate fragment turn ids", () => {
		const fragmentA = flow.fragment("a").turn(publishingTurn());
		const fragmentB = flow.fragment("b").turn(publishingTurn());

		expect(() =>
			flow
				.process("test_process")
				.displayName("Test")
				.entry("publish_plan")
				.codecs({ params: emptyParamsCodec, state: stateCodec })
				.initialState(() => ({}))
				.use(fragmentA)
				.use(fragmentB)
				.define(),
		).toThrow(/duplicate turn 'publish_plan'/);
	});

	it("publishes repository credential requirements without post-build mutation", () => {
		const process = flow
			.process("credential_process")
			.displayName("Credential process")
			.entry("publish_plan")
			.codecs({ params: emptyParamsCodec, state: stateCodec })
			.initialState(() => ({}))
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
		let calls = 0;
		const resolver = ({
			params,
			projects,
		}: {
			params: { large: boolean };
			projects: readonly unknown[];
		}) => {
			calls += 1;
			expect(projects).toEqual([]);
			return params.large ? "50Gi" : undefined;
		};
		const process = flow
			.process<{ large: boolean }, Record<string, never>>("storage_process")
			.displayName("Storage process")
			.entry("start")
			.codecs({
				params: { parse: () => ({ large: false }), serialize: (params) => params },
				state: stateCodec,
			})
			.initialState(() => ({}))
			.resolveStorageSize(resolver)
			.turn(
				flow
					.automatic<{ large: boolean }, Record<string, never>>("start")
					.description("Start")
					.run(async () => ({ outcome: "done", params: {} }))
					.outcome("done", (outcome) => outcome.description("Done").complete()),
			)
			.define();

		expect(calls).toBe(0);
		expect(process.resolveStorageSize).toBe(resolver);
		expect(process.resolveStorageSize?.({ params: { large: true }, projects: [] })).toBe("50Gi");
		expect(
			process.resolveStorageSize?.({ params: { large: false }, projects: [] }),
		).toBeUndefined();
	});

	it("delegates to defineProcess and composes fragment turns", () => {
		const fragment = flow.fragment("plan").turn(publishingTurn()).turn(consumingTurn());

		const process = flow
			.process("test_process")
			.displayName("Test Process")
			.entry("publish_plan")
			.codecs({ params: emptyParamsCodec, state: stateCodec })
			.initialState(() => ({}))
			.use(fragment)
			.define();

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
		const process = flow
			.process("alternate_entry_process")
			.displayName("Alternate Entry Process")
			.entry("publish_plan")
			.alternateEntry("consume_plan")
			.codecs({ params: emptyParamsCodec, state: stateCodec })
			.initialState(() => ({}))
			.turn(publishingTurn())
			.turn(consumingTurn())
			.define();

		expect(process.entryTurnId).toBe("publish_plan");
		expect(process.alternateEntryTurnIds).toEqual(["consume_plan"]);
	});
});
