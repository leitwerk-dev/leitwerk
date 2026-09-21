import { createProjectFixture } from "@leitwerk-dev/test-support/fixtures";
import { createExtensionTestHarness } from "@leitwerk-dev/test-support/process";
import { expect, it, onTestFinished } from "vitest";
import { createFinalizeChangeForm } from "./actions.js";
import { createRepositoryChangeProcess } from "./repository-change-process.js";

interface Params {
	launchKind: "requested_change";
	repoLocator: string;
	baseBranch: string;
	workBranch: string;
	prompt: string;
}
const definition = createRepositoryChangeProcess<Params>({
	processId: "coding_prompt_fixture",
	displayName: "Coding fixture",
	paramsCodec: { parse: (value) => value as Params, serialize: (value) => value },
	finalizeLabel: "Merge change",
	finalizeForm: createFinalizeChangeForm({ title: "Merge change" }),
	finalizationDescription: "Commit and merge",
}).process;

async function fixture() {
	const test = await createExtensionTestHarness();
	onTestFinished(() => test.close());
	const params: Params = {
		launchKind: "requested_change",
		repoLocator: "/tmp/original-repo",
		baseBranch: "sentinel-review-base",
		workBranch: "feature/test",
		prompt: "SENTINEL_REQUESTED_CHANGE",
	};
	return test.process(definition, {
		params,
		projects: [
			createProjectFixture({
				key: "repo",
				repoLocator: params.repoLocator,
				repoLocatorKind: "local_path",
				baseBranch: params.baseBranch,
				workBranch: params.workBranch,
			}),
		],
		products: { plan: "SENTINEL_PLAN" },
	});
}

it("describes review branches and their inspection tools", async () => {
	const process = await fixture();
	for (const id of ["review_plan", "review_implementation"]) {
		expect(process.describe().turns.find((turn) => turn.id === id)).toMatchObject({
			branchType: "root_branch",
			context: "full",
			availableTools: ["read", "bash"],
			startFrom: { kind: "semantic_ref", ref: "review", fallback: { kind: "session_root" } },
		});
	}
});

it("uses the workspace working directory in repository prompts", async () => {
	const process = await fixture();
	for (const [id, outcome] of [
		["generate_plan", "plan_saved"],
		["implement", "implementation-summary"],
		["review_implementation", "no_issues"],
	]) {
		const result = await process.evaluateTurn(id, {
			responses: [{ outcome, params: { summary: "Plan saved", acceptanceCriteria: ["Done"] } }],
		});
		const prompt = result.prompts[0];
		expect(prompt).toContain("current working directory");
		expect(prompt).not.toContain("/tmp/original-repo");
		expect(prompt).not.toContain("./repo");
	}
});

it("uses current instructions and repository state for implementation review", async () => {
	const process = await fixture();
	const result = await process.evaluateTurn("review_implementation", {
		responses: [{ outcome: "no_issues" }],
	});
	expect(result.prompts[0]).toContain("sentinel-review-base");
	expect(result.prompts[0]).toContain("SENTINEL_REQUESTED_CHANGE");
	expect(result.prompts[0]).not.toContain("SENTINEL_PLAN");
});

it("describes the implementation tool set and branch fallback", async () => {
	const process = await fixture();
	expect(process.describe().turns.find((turn) => turn.id === "implement")).toMatchObject({
		branchType: "primary",
		context: "fresh_seeded",
		availableTools: ["read", "bash", "edit", "write"],
		startFrom: {
			kind: "product_ref",
			productName: "simplification-plan",
			fallback: { kind: "semantic_ref", ref: "review", fallback: { kind: "session_root" } },
		},
	});
});

it("keeps simplification review read-only and independent of the original request", async () => {
	const process = await fixture();
	const result = await process.evaluateTurn("simplify_implementation", {
		responses: [{ outcome: "simplification-plan" }],
	});
	expect(result.prompts[0]).toContain("Repository root: . (the current working directory)");
	expect(result.prompts[0]).toContain("Find worthwhile ways to simplify");
	expect(result.prompts[0]).toContain("Inspect the repository read-only");
	expect(result.prompts[0]).not.toContain("SENTINEL_REQUESTED_CHANGE");
	expect(result.prompts[0]).not.toContain("SENTINEL_PLAN");
});
