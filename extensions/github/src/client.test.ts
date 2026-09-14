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

	it("summarizes pending, successful, and failed Actions checks", async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
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
				{ status: 200 },
			),
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
