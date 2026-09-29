import { describe, expect, it } from "vitest";
import { JiraClient, jiraIssueExternalId, parseJiraProfiles } from "./client.js";

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
});
