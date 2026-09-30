import { expect, it } from "vitest";
import { createGitLabRepoChange } from "./index.js";

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
