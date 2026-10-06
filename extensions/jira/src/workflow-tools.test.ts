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
import type { JiraIssue } from "./client.js";
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
		expect(write).toHaveBeenCalledTimes(1);
	});
	it.each([
		0, 2,
	])("rejects %s matching transitions and permits retry after workflow repair", async (count) => {
		const f = fixture();
		const candidate = f.client.transitions[0];
		f.client.transitions = Array.from({ length: count }, (_, i) => ({
			...candidate,
			id: String(i),
		}));
		const write = vi.spyOn(f.client, "transitionIssue");
		await expect(
			f.call("jira_transition_source_issue", { targetStatus: "In Progress" }),
		).rejects.toThrow(`found ${count}`);
		expect(write).not.toHaveBeenCalled();
		f.client.transitions = [candidate];
		await f.call("jira_transition_source_issue", { targetStatus: "In Progress" });
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
