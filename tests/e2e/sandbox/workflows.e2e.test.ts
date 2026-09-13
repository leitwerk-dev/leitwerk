import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { expect, test } from "vitest";
import { fixture, waitForResponse } from "./fixture.js";

test("public-only composition commits and merges a real notebook change after restart", async () => {
	const f = await fixture();
	try {
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
	} finally {
		await f.close();
	}
}, 60000);

test("controls use configured URLs, reject cross-origin writes and deduplicate launches", async () => {
	const f = await fixture();
	try {
		const state = (await f.context.app.inject("/__local/state")).json();
		expect(state.uiUrl).toBe("http://127.0.0.1:19173");
		expect(state.scenariosAvailable).toHaveLength(9);
		const payload = { name: "ticket", requestId: "repeat-launch-request" };
		const denied = await f.context.app.inject({
			method: "POST",
			url: "/__local/scenarios",
			headers: { origin: "https://example.test" },
			payload,
		});
		expect(denied.statusCode).toBe(403);
		const request = { method: "POST" as const, url: "/__local/scenarios", payload };
		const first = await f.context.app.inject(request);
		const second = await f.context.app.inject(request);
		expect(first.statusCode).toBe(202);
		expect(second.json().launchRunId).toBe(first.json().launchRunId);
		await waitForValue(
			() => f.context.deps.processes.listAll(),
			(p) => p.length === 1,
			12000,
		);
	} finally {
		await f.close();
	}
}, 30000);

test("retries the scripted failure and retains input and reasoning traces", async () => {
	const f = await fixture();
	try {
		const id = await f.launch("failure");
		await f.wait(id, "generate_plan", "error");
		const failed = f.context.deps.turnRecords.listByInstance(id).find((t) => t.status === "failed");
		if (!failed) throw new Error("No failed turn");
		const detail = await f.context.app.inject(
			`/api/processes/${id}/turn-records/${failed.id}/reasoning`,
		);
		expect(detail.json().reasoning.piInput.fullPrompt).toContain(
			"Document the weekly garden review",
		);
		const retry = await f.context.app.inject({
			method: "POST",
			url: `/api/processes/${id}/retry`,
			payload: {},
		});
		expect(retry.statusCode, retry.body).toBe(200);
		await f.wait(id, "plan_decision");
		expect(f.notebook.state.scenarios[id].step).toBe(2);
	} finally {
		await f.close();
	}
}, 30000);

test("questions and the fourth planning pass use ordinary question and review APIs", async () => {
	const f = await fixture();
	try {
		for (const name of ["question", "turn-rail"]) {
			const id = await f.launch(name);
			if (name === "turn-rail")
				for (let pass = 1; pass < 4; pass++) {
					await f.wait(id, "plan_decision");
					await f.action(id, "run_review");
					await f.wait(id, "plan_review_feedback");
					await f.action(id, "accept_review");
				}
			const question = await waitForValue(
				() => f.context.deps.questionRequests.listOpen(id)[0],
				Boolean,
				12000,
			);
			if (!question) throw new Error("Missing question");
			if (name === "turn-rail") expect(f.context.deps.processes.getById(id)?.planRevision).toBe(3);
			const response = await f.context.app.inject({
				method: "POST",
				url: `/api/processes/${id}/question-requests/${question.id}/answers`,
				payload: {
					draft: [
						{ selectedOptionIds: [question.questions[0].options[0].id], freeText: "", comment: "" },
					],
				},
			});
			expect(response.statusCode, response.body).toBe(200);
			await f.wait(id, "plan_decision");
		}
	} finally {
		await f.close();
	}
}, 60000);

test("long messages and streaming retain their actual Pi session records", async () => {
	const f = await fixture();
	try {
		const long = await f.launch("long-message");
		await f.wait(long, "plan_decision");
		expect(
			f.context.deps.turnRecords
				.listByInstance(long)
				.some((t) => (t.turnResultMarkdown?.length ?? 0) > 20000),
		).toBe(true);
		const id = await f.launch("streaming");
		await f.wait(id, "plan_decision", "waiting", 25000);
		const turn = f.context.deps.turnRecords.listByInstance(id).find((t) => t.turnType === "llm");
		if (!turn) throw new Error("Missing streaming turn");
		const response = await f.context.app.inject(`/api/processes/${id}/session`);
		expect(response.statusCode, response.body).toBe(200);
		expect(response.body).toContain("Observation 80");
		expect(response.body).toContain("Preparing the notebook change");
		await f.restart();
		expect((await f.context.app.inject(`/api/processes/${id}/session`)).body).toBe(response.body);
	} finally {
		await f.close();
	}
}, 60000);

test.each([
	"startup",
	"startup-cold",
])("%s can be cancelled before worker connection", async (name) => {
	const f = await fixture();
	try {
		const response = await f.context.app.inject({
			method: "POST",
			url: "/__local/scenarios",
			payload: { name, requestId: `${name}-cancel-request` },
		});
		expect(response.statusCode, response.body).toBe(202);
		const process = await waitForValue(() => f.context.deps.processes.listAll()[0], Boolean, 12000);
		if (!process) throw new Error("Missing process");
		await waitForResponse(
			async () =>
				(await f.context.app.inject(`/api/processes/${process.id}/ui-snapshot`)).json().startup,
			(s) => s?.attempts?.[0]?.steps[1]?.status === "in_progress",
			12000,
		);
		const aborted = await f.context.app.inject({
			method: "POST",
			url: `/api/processes/${process.id}/abort`,
			payload: {},
		});
		expect(aborted.statusCode, aborted.body).toBe(200);
		expect(f.context.deps.turnRecords.listByInstance(process.id)).toHaveLength(0);
		const state = (await f.context.app.inject(`/api/processes/${process.id}/ui-snapshot`)).json()
			.startup;
		expect(state.attempts[0].status).toBe("superseded");
	} finally {
		await f.close();
	}
}, 30000);

test("delayed startup reaches the ordinary planning decision and retains its observations", async () => {
	const f = await fixture();
	try {
		const id = await f.launch("startup");
		await f.wait(id, "plan_decision", "waiting", 30000);
		const startup = (await f.context.app.inject(`/api/processes/${id}/ui-snapshot`)).json().startup;
		expect(startup.attempts[0].status).toBe("succeeded");
		expect(
			startup.attempts[0].steps.every((step: { status: string }) => step.status === "completed"),
		).toBe(true);
		await f.restart();
		expect(
			(await f.context.app.inject(`/api/processes/${id}/ui-snapshot`)).json().startup.attempts,
		).toEqual(startup.attempts);
	} finally {
		await f.close();
	}
}, 60000);
