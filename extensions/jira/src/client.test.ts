import { describe, expect, it } from "vitest";
import { JiraClient, jiraIssueExternalId, parseJiraProfiles } from "./client.js";

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
	it("retains the context path, uses a PAT header, and follows server-sized pages", async () => {
		const requests: URL[] = [];
		const client = new JiraClient(
			{ baseUrl: "https://jira.test/context/", token: "server-only-secret" },
			async (url, init) => {
				const request = new URL(String(url));
				requests.push(request);
				expect(request.pathname).toBe("/context/rest/api/2/search");
				expect(init?.headers).toMatchObject({ Authorization: "Bearer server-only-secret" });
				expect(request.href).not.toContain("server-only-secret");
				expect(request.searchParams.get("jql")).toContain('labels = "use-leitwerk"');
				const startAt = Number(request.searchParams.get("startAt"));
				return Response.json({ startAt, total: 3, issues: [{ id: String(startAt + 1) }] });
			},
		);
		expect(await client.searchIssues(["100"])).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
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
});
