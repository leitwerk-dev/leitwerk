import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubClient, parseGitHubProfiles } from "./client.js";

afterEach(() => vi.unstubAllGlobals());

describe("GitHubClient", () => {
	it("parses server-owned profiles and rejects insecure API origins", () => {
		expect(
			parseGitHubProfiles({
				profiles: {
					public: { token: "secret", bot_login: "bot" },
				},
			}).get("public"),
		).toEqual({
			apiBaseUrl: "https://api.github.com",
			token: "secret",
			botLogin: "bot",
		});
		expect(() =>
			parseGitHubProfiles({
				profiles: {
					public: { api_base_url: "http://github.test", token: "x" },
				},
			}),
		).toThrow("HTTPS");
	});

	it("creates pull requests through the shared endpoints with GitHub headers", async () => {
		const fetch = vi.fn(async () => Response.json({ number: 7 }));
		vi.stubGlobal("fetch", fetch);
		const client = new GitHubClient({
			apiBaseUrl: "https://api.github.test",
			token: "secret",
			botLogin: "bot",
		});
		const input = { title: "Change", body: "Review", head: "feature", base: "main" };
		await expect(client.createPullRequest("team", "repo", input)).resolves.toEqual({ number: 7 });
		expect(fetch).toHaveBeenCalledWith(
			"https://api.github.test/repos/team/repo/pulls",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify(input),
				headers: expect.objectContaining({ Authorization: "Bearer secret" }),
			}),
		);
	});

	it("summarizes pending, successful, and failed Actions checks", async () => {
		const fetch = vi.fn().mockResolvedValue(
			Response.json({
				check_runs: [
					{
						name: "test",
						status: "completed",
						conclusion: "failure",
						html_url: "https://github.test/check/1",
					},
					{ name: "lint", status: "completed", conclusion: "success" },
				],
			}),
		);
		vi.stubGlobal("fetch", fetch);
		const client = new GitHubClient({
			apiBaseUrl: "https://api.github.test",
			token: "secret",
			botLogin: "bot",
		});
		expect(await client.getCheckSummary("leitwerk-dev", "leitwerk", "abc")).toMatchObject({
			headSha: "abc",
			status: "failure",
			failed: [{ name: "test", conclusion: "failure" }],
		});
		expect(fetch.mock.calls[0]?.[1]?.headers.Authorization).toBe("Bearer secret");
	});
});
