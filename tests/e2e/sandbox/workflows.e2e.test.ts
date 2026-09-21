import { expect } from "vitest";
import { test } from "../../../sandbox/testing/fixture.js";

test("public-only composition commits and publishes a real notebook change after restart", async ({
	f,
}) => {
	const mainSha = f.notebook.git(f.notebook.repository, ["rev-parse", "main"]);
	const id = await f.launch("repository-change");
	await f.wait(id, "plan_decision");
	const progress = f.notebook.state.scenarios[id];
	const records = f.context.deps.turnRecords.listByInstance(id);
	await f.restart();
	expect(f.notebook.state.scenarios[id]).toEqual(progress);
	expect(f.context.deps.turnRecords.listByInstance(id)).toEqual(records);
	await f.action(id, "approve_plan");
	await f.wait(id, "implementation_decision");
	await f.action(id, "finalize_change");
	await f.wait(id, null, "completed");
	const project = f.context.deps.projects.listByInstance(id)[0];
	if (!project?.workBranch) throw new Error("Missing sandbox work branch");
	expect(f.notebook.git(f.notebook.repository, ["rev-parse", "main"])).toBe(mainSha);
	expect(
		f.notebook.git(f.notebook.repository, ["show", `${project.workBranch}:notes.txt`]),
	).toContain("Weekly review");
	expect(
		f.notebook.git(f.notebook.repository, ["log", "-1", "--format=%B", project.workBranch]),
	).toContain("document weekly garden review");
}, 60000);
