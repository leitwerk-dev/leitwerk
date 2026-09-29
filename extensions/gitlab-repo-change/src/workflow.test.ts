import type { RepositoryChangeState } from "@leitwerk-dev/coding/repository-change-state";
import {
	buildServerProcessForTest,
	createTestProcessInstance,
	createTestServerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import type { GitLabIntegration } from "@leitwerk-dev/gitlab";
import { describe, expect, it } from "vitest";
import { createGitLabRepoChange } from "./index.js";
import type { GitLabRepoChangeParams } from "./params.js";

function fixture() {
	const flow = createGitLabRepoChange({ docker: false });
	let labels: string[] = [],
		reads = 0,
		unavailable = false;
	flow.launcher.configure({
		profiles: () => ["team"],
		client: () => ({
			baseUrl: "https://gitlab.test",
			async getIssue() {
				reads++;
				if (unavailable) throw new Error("Unavailable");
				return { labels };
			},
		}),
	} as unknown as GitLabIntegration);
	const params = {
		origin: "issue",
		gitlabProfile: "team",
		gitlabOrigin: "https://gitlab.test",
		projectId: 1,
		issueNumber: 1,
	} as GitLabRepoChangeParams;
	async function outcome(
		turnId: string,
		outcome: string,
		state = flow.process.stateCodec.parse({}),
		input = params,
	) {
		let next: { turnId?: string | null; state?: RepositoryChangeState } | undefined;
		const handler = buildServerProcessForTest(flow.process)?.turnOutcomeHandlers.get(turnId)?.[0];
		if (!handler) throw new Error(`Missing handler ${turnId}`);
		await handler(
			{
				turnRecordId: "turn-1",
				turnId,
				outcome,
				params: { summary: "Plan", acceptanceCriteria: ["Works"] },
				turnResultMarkdown: "# Plan",
			},
			createTestServerProcessContext({
				process: createTestProcessInstance({
					processId: flow.process.id,
					selectedTurnId: turnId,
					planRevision: 2,
				}),
				state,
				params: input,
				transition: async (value) => {
					next = value;
				},
				applyLifecycleEffects: async () => {},
			}),
		);
		return next;
	}
	return {
		flow,
		params,
		outcome,
		setLabels(value: string[]) {
			labels = value;
		},
		fail(value: boolean) {
			unavailable = value;
		},
		get reads() {
			return reads;
		},
	};
}
describe("streamlined GitLab workflow", () => {
	it("registers exactly the ten business turns and only human-comment plan revisions", () => {
		const { process } = createGitLabRepoChange({ docker: false });
		expect([...process.turns.keys()].sort()).toEqual(
			[
				"generate_plan",
				"plan_decision",
				"implement",
				"simplify_implementation",
				"apply_simplification",
				"generate_commit_message",
				"deliver_change",
				"revise_from_merge_request_feedback",
				"repair_gitlab_pipeline",
				"ci_operator_action",
			].sort(),
		);
		const turn = process.turns.get("plan_decision")?.definition;
		expect(turn?.kind).toBe("human");
		if (turn?.kind === "human")
			expect(Object.keys(turn.actions)).toEqual(["approve_plan", "request_revision"]);
	});
	it("records the launcher plan bypass against the new plan revision", async () => {
		const f = fixture();
		const next = await f.outcome("generate_plan", "plan_saved", undefined, {
			...f.params,
			origin: "ui",
			skipPlanDecision: true,
		} as GitLabRepoChangeParams);
		expect(next).toMatchObject({
			turnId: "implement",
			state: { routing: { plan: { skip: true, planRevision: 3 } } },
		});
	});
	it("does not use a GitLab issue label as a plan bypass", async () => {
		const f = fixture();
		f.setLabels(["leitwerk-skip-plan-decision"]);
		expect(await f.outcome("generate_plan", "plan_saved")).toMatchObject({
			turnId: "plan_decision",
		});
	});
	it("enables simplification by default and pins the routing decision for recovery", async () => {
		const f = fixture();
		const next = await f.outcome("implement", "implementation_ready");
		expect(next).toMatchObject({
			turnId: "simplify_implementation",
			state: { routing: { simplification: { skip: false } } },
		});
		f.setLabels(["leitwerk-skip-simplification"]);
		f.fail(true);
		expect(await f.outcome("implement", "implementation_ready", next?.state)).toMatchObject({
			turnId: "simplify_implementation",
		});
		expect(f.reads).toBe(1);
	});
	it("skips both simplification turns for a source label or launcher checkbox", async () => {
		const f = fixture();
		f.setLabels(["leitwerk-skip-simplification"]);
		expect(await f.outcome("implement", "implementation_ready")).toMatchObject({
			turnId: "generate_commit_message",
		});
		const reads = f.reads;
		expect(
			await f.outcome("implement", "implementation_ready", undefined, {
				...f.params,
				origin: "ui",
				skipSimplification: true,
			} as GitLabRepoChangeParams),
		).toMatchObject({ turnId: "generate_commit_message" });
		expect(f.reads).toBe(reads);
	});
	it("does not evaluate labels from a different GitLab installation", async () => {
		const f = fixture();
		await expect(
			f.outcome("implement", "implementation_ready", undefined, {
				...f.params,
				gitlabOrigin: "https://other.test",
			}),
		).rejects.toThrow("installation changed");
		expect(f.reads).toBe(0);
	});
	it("fails a policy lookup without routing, then retries with fresh labels", async () => {
		const f = fixture();
		f.fail(true);
		await expect(f.outcome("implement", "implementation_ready")).rejects.toThrow("Unavailable");
		f.fail(false);
		f.setLabels(["leitwerk-skip-simplification"]);
		expect(await f.outcome("implement", "implementation_ready")).toMatchObject({
			turnId: "generate_commit_message",
		});
	});
});
