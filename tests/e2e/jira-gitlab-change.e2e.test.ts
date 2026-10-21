import { describe, expect, it, vi } from "vitest";
import { jiraFixture } from "./jira-gitlab-fixture.js";

describe("Jira coordinated GitLab change", () => {
	it("blocks planning before acceptance when tool preparation fails and recovers on retry", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished, { toolchainUnavailable: true });
		await f.pollDiscovery();
		const id = f.harness.ctx.deps.processes.listAll()[0].id;
		await f.wait(id, "generate_plan", "error");
		expect(f.harness.ctx.deps.turnRecords.listByInstance(id)).toHaveLength(0);
		expect(f.prompts).toHaveLength(0);
		expect(f.issue.fields.status.statusCategory.key).toBe("new");
		expect(f.links).toHaveLength(0);

		f.setToolchainUnavailable(false);
		await f.post(`/api/processes/${id}/retry`);
		await f.wait(id, "plan_decision");
		expect(f.harness.ctx.deps.turnRecords.listByInstance(id)).toHaveLength(1);
		expect(f.issue.fields.status.name).toBe("In Progress");
		expect(f.prompts).toHaveLength(1);
	}, 45000);

	it("shows missing component mappings and automatically resumes the same process after restart", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished, { unmapped: true });
		const id = await f.discover();
		const read = () => {
			const process = f.harness.ctx.deps.processes.getById(id);
			if (!process) throw new Error("Missing process");
			return process;
		};
		await vi.waitFor(() =>
			expect(read().metadata?.turnWait).toMatchObject({
				message: expect.stringContaining("Shared"),
			}),
		);
		expect(read()).toMatchObject({ lifecycleStatus: "waiting", selectedTurnId: "generate_plan" });
		expect(f.params(id)).toMatchObject({ repositories: [], startup: { projectIds: ["100"] } });
		expect(f.harness.ctx.deps.projects.listByInstance(id)).toHaveLength(0);
		expect(f.harness.ctx.deps.turnStarts.listByInstance(id)).toHaveLength(0);
		expect(f.harness.ctx.deps.turnRecords.listByInstance(id)).toHaveLength(0);
		expect(f.harness.ctx.deps.leases.listByInstance(id)).toHaveLength(0);
		expect(f.prompts).toHaveLength(0);
		expect(f.links).toHaveLength(0);
		expect(f.issue.fields.status.statusCategory.key).toBe("new");
		const snapshot = await f.harness.ctx.app.inject({
			method: "GET",
			url: `/api/processes/${id}/ui-snapshot`,
		});
		expect(snapshot.statusCode).toBe(200);
		expect(snapshot.body).toContain("Settings → Jira components");
		expect(snapshot.body).toContain("Startup will resume automatically");
		await f.pollDiscovery();
		await f.restart();
		expect(f.harness.ctx.deps.processes.listAll().map((p) => p.id)).toEqual([id]);
		await f.mapComponent("202", [2]);
		await f.pollDiscovery();
		await f.wait(id, "plan_decision");
		expect(f.params(id).startup).toBeUndefined();
		expect(f.params(id).repositories.map((r) => r.projectId)).toEqual([1, 2]);
		expect(f.harness.ctx.deps.projects.listByInstance(id)).toHaveLength(2);
		expect(
			f.harness.ctx.deps.turnRecords.listByInstance(id).filter((t) => t.turnId === "generate_plan"),
		).toHaveLength(1);
		expect(f.harness.ctx.deps.processes.listAll().map((p) => p.id)).toEqual([id]);
	}, 45000);

	it("retries failed admission and deduplicates a renamed, relabeled issue after restart", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished);
		f.setUnavailable(true);
		expect((await f.pollDiscovery()).errors.join(" ")).toContain("admission failed");
		expect(f.harness.ctx.deps.processes.listAll()).toHaveLength(0);
		f.setUnavailable(false);
		const id = await f.discover();
		await f.wait(id, "plan_decision");
		expect(f.issue.fields.status.name).toBe("In Progress");
		expect(f.links.map((link) => link.object.url)).toEqual([
			`${f.harness.ctx.config.server.base_url}/processes/${id}`,
		]);
		expect(f.comments).toEqual([]);
		const retained = f.params(id);
		f.issue.fields.labels = [];
		await f.pollDiscovery();
		f.issue.fields.labels = ["use-leitwerk-beta"];
		f.issue.key = "RENAMED-500";
		await f.restart();
		expect((await f.pollDiscovery()).errors).toEqual([]);
		expect(f.harness.ctx.deps.processes.listAll().map((process) => process.id)).toEqual([id]);
		expect(f.params(id)).toEqual(retained);
	}, 45000);

	it("deduplicates component repositories, hands findings to application once, and completes mixed outcomes after restart", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished, { labelDuringSimplification: true });
		f.loseRemoteLink();
		f.gitlab.loseNextMergeRequestResponse = true;
		const id = await f.launch();
		expect(f.params(id).repositories).toHaveLength(2);
		expect(f.params(id).mappings).toHaveLength(3);
		expect(f.gitlab.state.mrs).toHaveLength(2);
		const processUrl = `${f.harness.ctx.config.server.base_url}/processes/${id}`;
		expect(f.links.map((link) => link.object.url)).toEqual([
			processUrl,
			...f.gitlab.state.mrs.map((mr) => mr.web_url),
		]);
		expect(f.issue.fields.status.name).toBe("In Review");
		for (const mr of f.gitlab.state.mrs) {
			expect(mr.description).toContain(`[Leitwerk process](${processUrl})`);
			expect(mr.description).toContain(`[APP-1](${f.params(id).issueUrl})`);
		}
		const turns = f.harness.ctx.deps.turnRecords.listByInstance(id);
		expect(turns.filter((turn) => turn.turnId === "simplify_implementation")).toHaveLength(1);
		expect(turns.filter((turn) => turn.turnId === "apply_simplification")).toHaveLength(1);
		expect(f.prompts.some(({ prompt }) => prompt.includes("repo_1: remove duplication."))).toBe(
			true,
		);
		await f.poll();
		expect(f.harness.ctx.deps.processes.listAll()).toHaveLength(1);
		await f.restart();
		await f.wait(id, "deliver_change");
		f.gitlab.merge(f.gitlab.state.mrs[0]);
		f.gitlab.state.mrs[1].state = "closed";
		f.gitlab.save();
		await f.poll();
		await f.wait(id, null, "completed");
		expect(f.issue.fields.labels).not.toContain("use-leitwerk-beta");
		expect(f.issue.fields.labels).not.toContain("leitwerk-done");
		expect(f.comments).toEqual([]);
		expect(f.issue.fields.status.name).toBe("In Review");
		await f.restart();
		await f.poll();
		expect(f.gitlab.state.mrs).toHaveLength(2);
		expect(f.comments).toEqual([]);
		expect(f.links).toHaveLength(3);
	}, 60000);

	it("bypasses the current plan from its Jira label and skips both simplification turns", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished, { skipPlan: true, skipSimplification: true });
		const id = await f.launch();
		const turns = f.harness.ctx.deps.turnRecords.listByInstance(id);
		expect(
			turns.some((turn) =>
				["plan_decision", "simplify_implementation", "apply_simplification"].includes(turn.turnId),
			),
		).toBe(false);
		expect(f.state(id).routing).toMatchObject({
			plan: { skip: true, planRevision: 1 },
			simplification: { skip: true },
		});
		for (const mr of f.gitlab.state.mrs) f.gitlab.merge(mr);
		await f.poll();
		await f.wait(id, null, "completed");
		for (const mr of f.gitlab.state.mrs) {
			expect(mr.labels).toContain("leitwerk-done");
			expect(mr.labels).not.toContain("leitwerk-active");
		}
		expect(f.issue.fields.labels).toContain("leitwerk-done");
		expect(f.issue.fields.status.name).toBe("In Review");
		expect(f.comments).toEqual([]);
	}, 45000);

	it("accepts human comments for a plan revision and observes label bypass while approval waits", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished, { emptyFindings: true });
		const id = await f.discover();
		await f.wait(id, "plan_decision");
		await f.action(id, "request_revision", { message: "Keep the client compatible" });
		await f.wait(id, "plan_decision");
		expect(f.harness.ctx.deps.processes.getById(id)?.planRevision).toBe(2);
		// Durable waiting state can precede reconciliation of the revised plan's subscription.
		await f.waitForPlanBypass(id, 2);
		f.issue.fields.labels.push("leitwerk-skip-plan-decision");
		await f.poll();
		await f.wait(id, "deliver_change");
		expect(f.state(id).routing.plan).toMatchObject({ skip: true, planRevision: 2 });
		expect(f.prompts.some(({ prompt }) => prompt.includes("No worthwhile simplifications."))).toBe(
			true,
		);
	}, 45000);

	it("completes a no-change implementation without opening requests or adding the done label", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished, { noChanges: true });
		const id = await f.launch();
		expect(f.gitlab.state.mrs).toHaveLength(0);
		expect(f.issue.fields.labels).toEqual([]);
		expect(f.comments).toEqual([]);
		expect(f.links.map((link) => link.object.url)).toEqual([
			`${f.harness.ctx.config.server.base_url}/processes/${id}`,
		]);
		expect(f.issue.fields.status.name).toBe("In Progress");
	}, 45000);

	it("retries partial publication without duplicate requests or source comments", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished);
		const id = await f.discover();
		f.setPublicationFailure(true);
		await f.action(id, "approve_plan");
		await f.wait(id, "deliver_change", "error");
		expect(f.gitlab.state.mrs).toHaveLength(1);
		expect(f.comments).toEqual([]);
		expect(f.links).toHaveLength(2);
		expect(f.issue.fields.status.name).toBe("In Progress");
		f.setPublicationFailure(false);
		await f.post(`/api/processes/${id}/retry`);
		await f.wait(id, "deliver_change");
		expect(f.gitlab.state.mrs).toHaveLength(2);
		expect(f.comments).toEqual([]);
		expect(f.links).toHaveLength(3);
		expect(f.issue.fields.status.name).toBe("In Review");
	}, 45000);

	it("pauses a failed simplification policy lookup and retries without guessing", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished);
		const id = await f.discover();
		f.setUnavailable(true);
		await f.action(id, "approve_plan");
		await f.wait(id, "implement", "error");
		expect(f.state(id).routing.simplification).toBeUndefined();
		f.setUnavailable(false);
		f.issue.fields.labels.push("leitwerk-skip-simplification");
		await f.post(`/api/processes/${id}/retry`);
		await f.wait(id, "deliver_change");
		expect(
			f.harness.ctx.deps.turnRecords
				.listByInstance(id)
				.some(
					(turn) =>
						turn.turnId === "simplify_implementation" || turn.turnId === "apply_simplification",
				),
		).toBe(false);
	}, 45000);
});
