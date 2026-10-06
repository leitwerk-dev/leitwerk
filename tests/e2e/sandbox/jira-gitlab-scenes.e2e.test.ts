import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { expect, test } from "vitest";
import composition from "../../../sandbox/jira-gitlab-composition.js";
import { fixture } from "../../../sandbox/testing/fixture.js";

test("Jira scene discovery deduplicates launches and publishes both mapped repositories", async ({
	onTestFinished,
}) => {
	const f = await fixture(onTestFinished, composition);
	const payload = { scene: "delivery", requestId: "review-delivery-example" };
	await f.post("/__local/jira/issues", payload);
	const process = await waitForValue(() => f.context.deps.processes.listAll()[0], Boolean, 12000);
	if (!process) throw new Error("Missing Jira scene");
	await f.wait(process.id, "plan_decision");
	await f.post("/__local/jira/issues", payload);
	expect(f.context.deps.processes.listAll()).toHaveLength(1);
	expect(f.context.deps.projects.listByInstance(process.id)).toHaveLength(2);
	await f.action(process.id, "approve_plan");
	await f.wait(process.id, "deliver_change", "waiting");
	const state = await waitForValue(
		async () => (await f.context.app.inject("/__local/state")).json(),
		(state) =>
			state.gitlab.mrs.length === 2 &&
			state.jira.remoteLinks["501"]?.length === 3 &&
			state.jira.issues[0].fields.status.name === "In Review",
		12000,
	);
	expect(state.gitlab.mrs).toHaveLength(2);
	expect(state.jira.comments["501"] ?? []).toEqual([]);
	expect(
		state.jira.remoteLinks["501"].map((link: { object: { url: string } }) => link.object.url),
	).toEqual([
		`${f.context.config.server.base_url}/processes/${process.id}`,
		...state.gitlab.mrs.map((mr: { web_url: string }) => mr.web_url),
	]);
	for (const mr of state.gitlab.mrs) {
		const response = await f.context.app.inject(new URL(mr.web_url).pathname);
		expect(response.statusCode).toBe(200);
		expect(response.body).toContain("+Show the expected delivery date range.");
		expect(response.body).not.toContain("+Display the expected delivery date range.");
	}
}, 60000);

test("the production GitLab launcher bypasses both optional turns in the sandbox", async ({
	onTestFinished,
}) => {
	const f = await fixture(onTestFinished, composition);
	const id = await f.launch(
		"gitlab_repo_change_process.ui_launcher",
		{
			gitlabProfile: "sandbox",
			gitSshProfile: "sandbox",
			repository: "1",
			prompt: "Clarify the delivery-window contract",
			skipPlanDecision: true,
			skipSimplification: true,
		},
		true,
	);
	await f.wait(id, "deliver_change", "waiting");
	const state = await waitForValue(
		async () => (await f.context.app.inject("/__local/state")).json(),
		(state) => state.gitlab.mrs.length === 1,
		12000,
	);
	expect(state.gitlab.mrs).toHaveLength(1);
	const response = await f.context.app.inject(new URL(state.gitlab.mrs[0].web_url).pathname);
	expect(response.body).toContain("+Display the expected delivery date range.");
	expect(response.body).toContain("+Show the date range for expected delivery.");
}, 60000);
