import {
	buildServerProcessForTest,
	createTestProcessInstance,
	createTestServerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import { flow } from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import { repositoryChangeWorkflow } from "./repository-change-launch-internal.js";
import { createRepositoryChangeProcess } from "./repository-change-process.js";
import type { RepositoryChangeState } from "./repository-change-state.js";

type Params = { origin: string; skipPlanDecision?: boolean; skipSimplification?: boolean };

function fixture() {
	const readLabels = vi.fn(async (): Promise<string[]> => []);
	const publication = flow.fragment<Params, RepositoryChangeState>("publication");
	publication.turn(
		flow
			.automatic<Params, RepositoryChangeState>("deliver_change")
			.description("Deliver")
			.run(async () => ({ outcome: "completed" }))
			.outcome("completed", (o) => o.description("Delivered").complete()),
	);
	const { process } = createRepositoryChangeProcess<Params>({
		processId: "test_change",
		displayName: "Test change",
		paramsCodec: { parse: (value) => value as Params, serialize: (value) => value },
		workflow: repositoryChangeWorkflow(readLabels),
		publication: { entryTurnId: "deliver_change", fragment: publication },
	});
	expect(process.turns.get("implement")).toHaveProperty(
		"definition.startFrom.kind",
		"session_root",
	);
	const handlers = buildServerProcessForTest(process)?.turnOutcomeHandlers;
	async function outcome(
		turnId: "generate_plan" | "implement",
		params: Params = { origin: "issue" },
		state = process.stateCodec.parse({}),
	) {
		const transition = vi.fn();
		await handlers?.get(turnId)?.[0](
			{
				turnRecordId: "turn-1",
				turnId,
				outcome: turnId === "generate_plan" ? "plan_saved" : "implementation_ready",
				params: { summary: "Plan", acceptanceCriteria: ["Works"] },
				turnResultMarkdown: "# Plan",
			},
			createTestServerProcessContext({
				process: createTestProcessInstance({
					processId: process.id,
					selectedTurnId: turnId,
					planRevision: 2,
				}),
				state,
				params,
				transition,
				applyLifecycleEffects: async () => {},
			}),
		);
		expect(transition).toHaveBeenCalledOnce();
		return transition.mock.calls[0][0] as { turnId: string; state: RepositoryChangeState };
	}
	return { readLabels, outcome };
}

describe("repository change routing", () => {
	it.each(["ui", "issue"])("only permits launcher plan bypass for %s origin", async (origin) => {
		const f = fixture();
		f.readLabels.mockResolvedValue(["leitwerk-skip-plan-decision"]);
		expect(await f.outcome("generate_plan", { origin, skipPlanDecision: true })).toMatchObject({
			turnId: origin === "ui" ? "implement" : "plan_decision",
			state: { routing: { plan: { skip: origin === "ui", planRevision: 3 } } },
		});
		expect(f.readLabels).not.toHaveBeenCalled();
	});
	it("pins the default simplification decision for recovery", async () => {
		const f = fixture();
		const next = await f.outcome("implement");
		expect(next).toMatchObject({
			turnId: "simplify_implementation",
			state: { routing: { simplification: { skip: false } } },
		});
		f.readLabels.mockRejectedValue(new Error("Unavailable"));
		expect(await f.outcome("implement", undefined, next.state)).toMatchObject({
			turnId: "simplify_implementation",
		});
		expect(f.readLabels).toHaveBeenCalledOnce();
	});
	it.each(["ui", "issue"])("skips both simplification turns for %s origin", async (origin) => {
		const f = fixture();
		f.readLabels.mockResolvedValue(["leitwerk-skip-simplification"]);
		expect(await f.outcome("implement", { origin, skipSimplification: true })).toMatchObject({
			turnId: "generate_commit_message",
		});
		expect(f.readLabels).toHaveBeenCalledTimes(origin === "ui" ? 0 : 1);
	});
	it("retries a failed policy lookup with fresh labels", async () => {
		const f = fixture();
		f.readLabels.mockRejectedValueOnce(new Error("Unavailable"));
		await expect(f.outcome("implement")).rejects.toThrow("Unavailable");
		f.readLabels.mockResolvedValue(["leitwerk-skip-simplification"]);
		expect(await f.outcome("implement")).toMatchObject({ turnId: "generate_commit_message" });
	});
});
