import {
	createTestProcessInstance,
	createTestProcessProject,
} from "@leitwerk-dev/extension-runtime/testing";
import {
	coreHostCapabilities,
	type IntegrationToolExecutionContext,
} from "@leitwerk-dev/process-sdk";
import {
	createInMemoryExternalWriteLog,
	createTestServerSetupCapability,
	createToolCollector,
} from "@leitwerk-dev/test-support";
import { describe, expect, it, vi } from "vitest";
import { JiraClient, type JiraIssue } from "./client.js";
import { LocalJiraSplitAdapter } from "./testing.js";
import { registerJiraTools } from "./tools.js";

function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Missing fixture value");
	return value;
}

function fixture() {
	const client = new LocalJiraSplitAdapter();
	const issue: JiraIssue = {
		id: "501",
		key: "APP-1",
		fields: {
			summary: "Change",
			description: null,
			labels: ["use-leitwerk"],
			components: [],
			project: { id: "100", key: "APP", name: "App" },
			status: { id: "1", name: "Open", statusCategory: { key: "new" } },
		},
	};
	client.seedIssue(issue);
	const project = createTestProcessProject({
		id: "repository",
		key: "repo_1",
		repoLocator: "https://gitlab.test/team/service-name.git",
		externalId: "7",
		externalUrl: "https://gitlab.test/team/service-name/-/merge_requests/7",
		metadata: {
			jira: { profile: "team", baseUrl: client.baseUrl, issueId: issue.id },
			gitlab: { iid: 7 },
		},
	});
	const ctx = {
		process: createTestProcessInstance({ id: "process" }),
		project,
		projects: [project],
		signal: new AbortController().signal,
	} as IntegrationToolExecutionContext;
	let writes = createInMemoryExternalWriteLog();
	const register = () => {
		const collector = createToolCollector(writes);
		const deps = createTestServerSetupCapability({ serverBaseUrl: "https://leitwerk.test/app/" });
		registerJiraTools(
			{
				...collector.api,
				get: (token) => (token === coreHostCapabilities.serverSetup ? (deps as never) : undefined),
			},
			{ profiles: () => ["team"], client: () => client },
		);
		return collector.tools;
	};
	let tools = register();
	return {
		client,
		ctx,
		issue,
		call: (name: string, args: Record<string, unknown>) =>
			required(tools.get(name)).execute(ctx, args),
		restart() {
			writes = createInMemoryExternalWriteLog();
			tools = register();
		},
	};
}

describe("Jira workflow writes", () => {
	it("exposes a Markdown source description while preserving Jira fields", async () => {
		const f = fixture();
		f.issue.fields.description = "h2. Requirements\n\n* *Check* {{user_name}}";
		f.client.seedIssue(f.issue);
		expect(await f.call("jira_get_source_issue", {})).toMatchObject({
			fields: { description: f.issue.fields.description },
			descriptionMarkdown: "## Requirements\n\n- **Check** `user_name`",
		});
		expect((await f.client.getIssue(f.issue.id)).fields.description).toBe(
			f.issue.fields.description,
		);
		f.issue.fields.description = null;
		f.client.seedIssue(f.issue);
		expect(await f.call("jira_get_source_issue", {})).toMatchObject({
			fields: { description: null },
			descriptionMarkdown: "",
		});
	});

	it("creates native process/MR links and recovers lost responses and local receipts", async () => {
		const f = fixture();
		const upsert = f.client.upsertRemoteLink.bind(f.client);
		const write = vi
			.spyOn(f.client, "upsertRemoteLink")
			.mockImplementationOnce(async (id, input) => {
				await upsert(id, input);
				throw new Error("Response lost");
			});
		expect(await f.call("jira_ensure_remote_link", { kind: "process" })).toMatchObject({
			url: "https://leitwerk.test/app/processes/process",
		});
		await f.call("jira_ensure_remote_link", { kind: "merge_request" });
		f.restart();
		await f.call("jira_ensure_remote_link", { kind: "process" });
		await f.call("jira_ensure_remote_link", { kind: "merge_request" });
		expect(write).toHaveBeenCalledTimes(2);
		expect(await f.client.listRemoteLinks("501")).toMatchObject([
			{ object: { title: "Leitwerk process process" } },
			{
				object: {
					url: "https://gitlab.test/team/service-name/-/merge_requests/7",
					title: "GitLab service-name !7",
				},
			},
		]);
		expect(await f.client.listComments("501")).toEqual([]);
	});
	it("discovers destination status and recovers a lost transition response without rewinding review", async () => {
		const f = fixture();
		f.client.transitions[0].to.name = " In pRoGrEsS ";
		const transition = f.client.transitionIssue.bind(f.client);
		const write = vi
			.spyOn(f.client, "transitionIssue")
			.mockImplementationOnce(async (id, transitionId) => {
				await transition(id, transitionId);
				throw new Error("Response lost");
			});
		await f.call("jira_transition_source_issue", { targetStatus: "In Progress" });
		await f.call("jira_transition_source_issue", { targetStatus: "In Review" });
		f.restart();
		await f.call("jira_transition_source_issue", { targetStatus: "In Progress" });
		await f.call("jira_transition_source_issue", { targetStatus: "In Review" });
		expect(write).toHaveBeenCalledTimes(2);
		expect((await f.client.getIssue("501")).fields.status.name).toBe("In Review");
	});
	it("recovers verification after a lost response and never rewinds it after losing receipts", async () => {
		const f = fixture();
		required(f.client.issues.get("501")).fields.status.name = "In Review";
		const candidate = required(f.client.transitions.find((t) => t.to.name === "In Verification"));
		candidate.to.name = " In vErIfIcAtIoN ";
		const transition = f.client.transitionIssue.bind(f.client);
		const write = vi
			.spyOn(f.client, "transitionIssue")
			.mockImplementationOnce(async (id, transitionId) => {
				await transition(id, transitionId);
				throw new Error("Response lost");
			});
		await f.call("jira_transition_source_issue", { targetStatus: "In Verification" });
		f.restart();
		for (const targetStatus of ["In Progress", "In Review", "In Verification"])
			await f.call("jira_transition_source_issue", { targetStatus });
		expect(write).toHaveBeenCalledTimes(1);
		expect((await f.client.getIssue("501")).fields.status.name).toBe(" In vErIfIcAtIoN ");
		required(f.client.issues.get("501")).fields.status = {
			name: "Paused",
			statusCategory: { key: "new" },
		};
		await f.call("jira_transition_source_issue", { targetStatus: "In Verification" });
		expect((await f.client.getIssue("501")).fields.status.name).toBe("Paused");
		expect(write).toHaveBeenCalledTimes(1);
	});
	it("preserves later human status edits and never reopens Done tickets", async () => {
		const f = fixture();
		const write = vi.spyOn(f.client, "transitionIssue");
		await f.call("jira_transition_source_issue", { targetStatus: "In Progress" });
		required(f.client.issues.get("501")).fields.status = {
			name: "Paused",
			statusCategory: { key: "new" },
		};
		await f.call("jira_transition_source_issue", { targetStatus: "In Progress" });
		expect((await f.client.getIssue("501")).fields.status.name).toBe("Paused");
		required(f.client.issues.get("501")).fields.status = {
			name: "Done",
			statusCategory: { key: "done" },
		};
		f.restart();
		await f.call("jira_transition_source_issue", { targetStatus: "In Review" });
		await f.call("jira_transition_source_issue", { targetStatus: "In Verification" });
		expect(write).toHaveBeenCalledTimes(1);
	});
	it.each(
		["In Progress", "In Verification"].flatMap((targetStatus) =>
			[0, 2].map((count) => ({ targetStatus, count })),
		),
	)("rejects $count matching $targetStatus transitions and permits retry after workflow repair", async ({
		targetStatus,
		count,
	}) => {
		const f = fixture();
		const candidate = required(f.client.transitions.find((t) => t.to.name === targetStatus));
		f.client.transitions = Array.from({ length: count }, (_, i) => ({
			...candidate,
			id: String(i),
		}));
		const write = vi.spyOn(f.client, "transitionIssue");
		await expect(f.call("jira_transition_source_issue", { targetStatus })).rejects.toThrow(
			`found ${count}`,
		);
		expect(write).not.toHaveBeenCalled();
		f.client.transitions = [candidate];
		await f.call("jira_transition_source_issue", { targetStatus });
		expect(write).toHaveBeenCalledTimes(1);
	});
	it("fails denied writes and lookup errors without recording success", async () => {
		const f = fixture();
		const write = vi
			.spyOn(f.client, "upsertRemoteLink")
			.mockRejectedValue(new Error("Permission denied"));
		await expect(f.call("jira_ensure_remote_link", { kind: "process" })).rejects.toThrow(
			"Permission denied",
		);
		write.mockRestore();
		await f.call("jira_ensure_remote_link", { kind: "process" });
		vi.spyOn(f.client, "listRemoteLinks").mockRejectedValue(new Error("Unavailable"));
		await expect(f.call("jira_ensure_remote_link", { kind: "process" })).rejects.toThrow(
			"Unavailable",
		);
		const transition = vi
			.spyOn(f.client, "transitionIssue")
			.mockRejectedValue(new Error("Transition denied"));
		await expect(
			f.call("jira_transition_source_issue", { targetStatus: "In Progress" }),
		).rejects.toThrow("Transition denied");
		expect((await f.client.getIssue("501")).fields.status.name).toBe("Open");
		transition.mockRestore();
		await f.call("jira_transition_source_issue", { targetStatus: "In Progress" });
		expect((await f.client.getIssue("501")).fields.status.name).toBe("In Progress");
	});
	it("rejects unpinned MR links and changed Jira installations", async () => {
		const f = fixture();
		required(f.ctx.project).externalUrl = null;
		await expect(f.call("jira_ensure_remote_link", { kind: "merge_request" })).rejects.toThrow(
			"pinned merge request",
		);
		required(f.ctx.project).metadata = {
			jira: { profile: "team", baseUrl: "https://other.test", issueId: "501" },
		};
		await expect(
			f.call("jira_transition_source_issue", { targetStatus: "In Progress" }),
		).rejects.toThrow("installation changed");
	});
});

it("reads related issues through the bound profile while keeping source reads pinned", async () => {
	const f = fixture();
	const requests: { url: string; init?: RequestInit }[] = [];
	const client = new JiraClient(
		{ baseUrl: f.client.baseUrl, token: "fixture-token" },
		async (url, init) => {
			requests.push({ url: String(url), init });
			return Response.json({
				...f.issue,
				fields: { ...f.issue.fields, description: "h2. Related" },
			});
		},
	);
	const getIssue = vi.spyOn(client, "getIssue");
	const chooseClient = vi.fn((profile: string) => {
		expect(profile).toBe("team");
		return client;
	});
	const tools = createToolCollector();
	registerJiraTools(tools.api, { profiles: () => ["team"], client: chooseClient });
	const read = required(tools.tools.get("jira_get_issue"));
	const source = required(tools.tools.get("jira_get_source_issue"));
	expect(read.parameters).toMatchObject({ required: ["projectKey", "issueKey"] });
	expect(source.parameters).toMatchObject({ required: ["projectKey"] });
	expect(
		(source.parameters as { properties: Record<string, unknown> }).properties,
	).not.toHaveProperty("body");
	expect(await read.execute(f.ctx, { issueKey: "APP-2/linked?" })).toMatchObject({
		fields: { description: "h2. Related" },
		descriptionMarkdown: "## Related",
	});
	await source.execute(f.ctx, { issueKey: "APP-999" });
	expect(requests.map(({ url }) => url)).toEqual([
		`${client.baseUrl}/rest/api/2/issue/APP-2%2Flinked%3F?fields=*all`,
		`${client.baseUrl}/rest/api/2/issue/501?fields=*all`,
	]);
	for (const { init } of requests) {
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
	}
	expect(getIssue).toHaveBeenNthCalledWith(1, "APP-2/linked?", f.ctx.signal);
	expect(getIssue).toHaveBeenNthCalledWith(2, "501", f.ctx.signal);
	expect(chooseClient).toHaveBeenCalledTimes(2);
	const project = required(f.ctx.project);
	project.metadata = {
		...project.metadata,
		jira: { profile: "team", baseUrl: "https://changed.test", issueId: "501" },
	};
	await expect(read.execute(f.ctx, { issueKey: "APP-2" })).rejects.toThrow(
		"Jira profile installation changed",
	);
	expect(requests).toHaveLength(2);
});
