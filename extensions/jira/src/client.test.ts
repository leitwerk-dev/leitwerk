import { describe, expect, it } from "vitest";
import { JiraClient, type JiraIssue, jiraIssueExternalId, parseJiraProfiles } from "./client.js";

const linkedIssue = {
	id: "101",
	key: "APP-101",
	fields: { issuetype: { id: "1", name: "Story" }, customfield_100: "APP-10" },
} as unknown as JiraIssue;

describe("Jira Data Center boundary", () => {
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
		expect(await client.createIssue(fields)).toEqual({ id: "101", key: "APP-101" });
		await expect(client.findSplitIssue("100", marker)).rejects.toThrow("Multiple Jira tickets");
		await expect(client.findSplitIssue("100", "untrusted marker")).rejects.toThrow(
			"Invalid split ticket identity",
		);
	});
});
