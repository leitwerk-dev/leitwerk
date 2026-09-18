import { expect } from "vitest";
import { test } from "../../../sandbox/testing/fixture.js";

test("public-only composition commits and merges a real notebook change after restart", async ({
	f,
}) => {
	const before = f.notebook.git(f.notebook.repository, ["rev-parse", "main"]);
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
	expect(f.notebook.git(f.notebook.repository, ["rev-parse", "main"])).not.toBe(before);
	expect(f.notebook.git(f.notebook.repository, ["show", "main:notes.txt"])).toContain(
		"Weekly review",
	);
	expect(f.notebook.git(f.notebook.repository, ["log", "-1", "--format=%B"])).toContain(
		"document weekly garden review",
	);
}, 60000);
