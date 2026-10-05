import { describe, expect, it } from "vitest";
import { JiraClient, type JiraIssue, jiraIssueExternalId, parseJiraProfiles } from "./client.js";

const linkedIssue = {
	id: "101",
	key: "APP-101",
	fields: { issuetype: { id: "1", name: "Story" }, customfield_100: "APP-10" },
} as unknown as JiraIssue;

describe("Jira Data Center boundary", () => {
	it("cancels an in-flight issue creation request with the caller's signal", async () => {
		const controller = new AbortController();
		const signals: Array<AbortSignal | null | undefined> = [];
		const client = new JiraClient(
			{ baseUrl: "https://jira.test", token: "test" },
			async (_url, init) => {
				signals.push(init?.signal);
				controller.abort();
				init?.signal?.throwIfAborted();
				return Response.json({ id: "7" });
			},
		);
		await expect(client.createIssue({ summary: "Review" }, controller.signal)).rejects.toThrow();
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(true);
	});

	it("loads creation metadata, sends selected fields, and reconciles all project issues", async () => {
		const requests: { url: URL; init?: RequestInit }[] = [];
		const project = { id: "100", key: "GARDEN", name: "Garden" };
		const issueType = { id: "10", name: "Task", subtask: false };
		const createFields = [
			{ fieldId: "summary", name: "Summary", required: true },
			{ fieldId: "customfield_10001", name: "Team", required: true },
		];
		const client = new JiraClient(
			{ baseUrl: "https://jira.test/context", token: "secret" },
			async (url, init) => {
				const request = new URL(String(url));
				requests.push({ url: request, init });
				if (request.pathname.endsWith("/project/100")) return Response.json(project);
				if (request.pathname.endsWith("/project")) return Response.json([project]);
				if (request.pathname.endsWith("/issuetypes"))
					return Response.json({
						start: 0,
						last: true,
						values: [issueType, { id: "11", name: "Subtask", subtask: true }],
					});
				if (request.pathname.endsWith("/issuetypes/10")) {
					const start = Number(request.searchParams.get("startAt"));
					return Response.json({ start, last: start === 1, values: [createFields[start]] });
				}
				if (request.pathname.endsWith("search"))
					return Response.json({ total: 1, issues: [{ id: "7", key: "GARDEN-7" }] });
				return Response.json({ id: "7", key: "GARDEN-7" });
			},
		);
		const expected = [
			{
				...project,
				issuetypes: [
					{
						...issueType,
						fields: {
							summary: { name: "Summary", required: true },
							customfield_10001: { name: "Team", required: true },
						},
					},
				],
			},
		];
		expect(await client.listCreateProjects("100")).toEqual(expected);
		expect(requests.map(({ url }) => `${url.pathname}?${url.searchParams.get("startAt")}`)).toEqual(
			[
				"/context/rest/api/2/project/100?null",
				"/context/rest/api/2/issue/createmeta/100/issuetypes?0",
				"/context/rest/api/2/issue/createmeta/100/issuetypes/10?0",
				"/context/rest/api/2/issue/createmeta/100/issuetypes/10?1",
			],
		);
		expect(await client.listCreateProjects()).toEqual(expected);
		const fields = {
			project: { id: "100" },
			issuetype: { id: "10" },
			summary: "Review",
			description: "Checklist",
			customfield_10001: "Gardeners",
		};
		await client.createIssue(fields);
		const write = requests.find(({ init }) => init?.method === "POST");
		expect(write?.url.pathname).toBe("/context/rest/api/2/issue");
		expect(JSON.parse(String(write?.init?.body))).toEqual({ fields });
		expect(await client.listProjectIssues("100")).toEqual([{ id: "7", key: "GARDEN-7" }]);
		expect(requests.at(-1)?.url.searchParams.get("jql")).toBe("project = 100 ORDER BY id ASC");
	});
	it.each([
		undefined,
		"use-leitwerk-beta",
	])("retains context, credentials and pagination with trigger %s", async (triggerLabel) => {
		const requests: URL[] = [];
		const client = new JiraClient(
			{ baseUrl: "https://jira.test/context/", token: "server-only-secret" },
			async (url, init) => {
				const request = new URL(String(url));
				requests.push(request);
				expect(request.pathname).toBe("/context/rest/api/2/search");
				expect(init?.headers).toMatchObject({ Authorization: "Bearer server-only-secret" });
				expect(request.href).not.toContain("server-only-secret");
				expect(request.searchParams.get("jql")).toContain(
					`labels = "${triggerLabel ?? "use-leitwerk"}"`,
				);
				const startAt = Number(request.searchParams.get("startAt"));
				return Response.json({ startAt, total: 3, issues: [{ id: String(startAt + 1) }] });
			},
		);
		expect(await client.searchIssues(["100"], triggerLabel)).toEqual([
			{ id: "1" },
			{ id: "2" },
			{ id: "3" },
		]);
		expect(requests).toHaveLength(3);
		expect(JSON.stringify(client)).not.toContain("server-only-secret");
	});
	it("does not forward credentials through redirects or expose response bodies", async () => {
		const client = new JiraClient(
			{ baseUrl: "https://jira.test/jira", token: "secret" },
			async (_url, init) => {
				expect(init?.redirect).toBe("error");
				return new Response("secret invalid PAT", { status: 403 });
			},
		);
		await expect(client.getIssue("123")).rejects.toThrow("Jira request failed (403)");
	});
	it("separates installations by context path and issues by immutable ID", () => {
		expect(jiraIssueExternalId("https://jira.test/a/", "123")).toBe(
			jiraIssueExternalId("https://jira.test/a", "123"),
		);
		expect(jiraIssueExternalId("https://jira.test/a", "123")).not.toBe(
			jiraIssueExternalId("https://jira.test/b", "123"),
		);
		expect(() =>
			parseJiraProfiles({
				profiles: { team: { base_url: "https://user:token@jira.test", token: "secret" } },
			}),
		).toThrow();
	});
	it("rejects incomplete pagination and empty project selection", async () => {
		const client = new JiraClient({ baseUrl: "https://jira.test", token: "secret" }, async () =>
			Response.json({ startAt: 0, total: 5, comments: [] }),
		);
		await expect(client.listComments("123")).rejects.toThrow("incomplete page");
		expect(() => client.searchIssues([])).toThrow("explicit Jira project IDs");
	});
	it("uses label operations without replacing unrelated labels or changing status", async () => {
		const client = new JiraClient(
			{ baseUrl: "https://jira.test", token: "secret" },
			async (_url, init) => {
				expect(JSON.parse(String(init?.body))).toEqual({
					update: { labels: [{ remove: "use-leitwerk" }, { add: "leitwerk-done" }] },
				});
				return new Response(null, { status: 204 });
			},
		);
		await client.updateLabels("123", ["use-leitwerk"], ["leitwerk-done"]);
	});
	it("discovers Epic Link by schema, retains project create fields, and reuses the field", async () => {
		const requests: string[] = [];
		const issueTypes = [{ id: "1", name: "Story", fields: { summary: { required: true } } }];
		const client = new JiraClient(
			{ baseUrl: "https://jira.test/context", token: "secret" },
			async (url) => {
				const request = new URL(String(url));
				requests.push(request.pathname);
				if (request.pathname.endsWith("/createmeta")) {
					expect(request.searchParams.get("projectIds")).toBe("100");
					expect(request.searchParams.get("expand")).toBe("projects.issuetypes.fields");
					return Response.json({ projects: [{ id: "100", issuetypes: issueTypes }] });
				}
				if (request.pathname.endsWith("/field"))
					return Response.json([
						{
							id: "customfield_100",
							name: "Localized field name",
							schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
						},
					]);
				expect(request.pathname).toBe("/context/rest/api/2/issue/APP-10");
				expect(request.searchParams.get("fields")).toBe("*all");
				return Response.json({ id: "10", key: "APP-10" });
			},
		);
		expect(await client.createMetadata("100")).toEqual({
			epicLinkField: "customfield_100",
			issueTypes,
		});
		expect(await client.getEpic(linkedIssue)).toMatchObject({ id: "10" });
		expect(requests.filter((path) => path.endsWith("/field"))).toHaveLength(1);
	});
	it("keeps ordinary Jira changes available without Epic Link but requires it for splitting", async () => {
		const client = new JiraClient({ baseUrl: "https://jira.test", token: "secret" }, async (url) =>
			Response.json(
				String(url).includes("createmeta") ? { projects: [{ id: "100", issuetypes: [] }] } : [],
			),
		);
		expect(await client.getEpic(linkedIssue)).toBeNull();
		await expect(client.createMetadata("100")).rejects.toThrow("requires an Epic Link field");
	});
	it("reads subtask metadata without discovering Epic Link", async () => {
		const issueTypes = [
			{ id: "5", name: "Unteraufgabe", subtask: true, fields: { parent: { required: true } } },
		];
		const client = new JiraClient(
			{ baseUrl: "https://jira.test", token: "secret" },
			async (url) => {
				expect(new URL(String(url)).pathname).toBe("/rest/api/2/issue/createmeta");
				return Response.json({ projects: [{ id: "100", issuetypes: issueTypes }] });
			},
		);
		expect(await client.createMetadata("100", false)).toEqual({ epicLinkField: null, issueTypes });
	});
	it("discovers split candidates under both labels without restricting to epics", async () => {
		const client = new JiraClient(
			{ baseUrl: "https://jira.test", token: "secret" },
			async (url) => {
				const jql = new URL(String(url)).searchParams.get("jql");
				expect(jql).toContain('labels in ("leitwerk-issue-split", "leitwerk-epic-split")');
				expect(jql).toContain("issuetype not in subTaskIssueTypes()");
				expect(jql).not.toContain("issuetype = Epic");
				expect(jql).toContain("statusCategory != Done");
				return Response.json({ issues: [linkedIssue], total: 1 });
			},
		);
		expect(await client.searchSplitIssues(["100"])).toEqual([linkedIssue]);
		expect(() => client.searchSplitIssues([])).toThrow("explicit Jira project IDs");
	});
	it("requires an override for ambiguous Epic Link discovery and validates the override", async () => {
		const fetcher = async () =>
			Response.json(
				["100", "200"].map((id) => ({
					id: `customfield_${id}`,
					schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
				})),
			);
		await expect(
			new JiraClient({ baseUrl: "https://jira.test", token: "secret" }, fetcher).getEpic(
				linkedIssue,
			),
		).rejects.toThrow("ambiguous");
		const client = new JiraClient(
			{ baseUrl: "https://jira.test", token: "secret", epicLinkField: "customfield_100" },
			async (url) => {
				expect(String(url)).toContain("/issue/APP-10?");
				return Response.json({ id: "10" });
			},
		);
		expect(await client.getEpic(linkedIssue)).toMatchObject({ id: "10" });
		expect(() =>
			parseJiraProfiles({
				profiles: {
					team: { base_url: "https://jira.test", token: "secret", epic_link_field: "labels" },
				},
			}),
		).toThrow("custom field");
	});
	it("creates fields exactly once per request and rejects duplicate reconciliation matches", async () => {
		const marker = `leitwerk-split-${"a".repeat(64)}`;
		const fields = {
			project: { id: "100" },
			summary: "Standardize",
			customfield_100: "APP-10",
			labels: [marker],
		};
		const client = new JiraClient(
			{ baseUrl: "https://jira.test", token: "secret" },
			async (url, init) => {
				if (init?.method === "POST") {
					expect(JSON.parse(String(init.body))).toEqual({ fields });
					return Response.json({ id: "101", key: "APP-101" }, { status: 201 });
				}
				const request = new URL(String(url));
				expect(request.searchParams.get("jql")).toContain(`labels = "${marker}"`);
				return Response.json({ startAt: 0, total: 2, issues: [{ id: "101" }, { id: "102" }] });
			},
		);
		expect(await client.createIssueReceipt(fields)).toEqual({ id: "101", key: "APP-101" });
		await expect(client.findSplitIssue("100", marker)).rejects.toThrow("Multiple Jira tickets");
		await expect(client.findSplitIssue("100", "untrusted marker")).rejects.toThrow(
			"Invalid split ticket identity",
		);
	});
});

it("rejects a later failed discovery page instead of returning a partial issue list", async () => {
	let page = 0;
	const client = new JiraClient(
		{ baseUrl: "https://jira.test/context", token: "secret" },
		async () => {
			page++;
			return page === 1
				? Response.json({ startAt: 0, total: 2, issues: [{ id: "501" }] })
				: new Response(null, { status: 503 });
		},
	);
	await expect(client.searchIssues(["10100"])).rejects.toThrow("503");
	expect(page).toBe(2);
});
