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

describe("GitHub trigger authorization", () => {
	const issue = { number: 1, state: "open", labels: [{ name: "use-leitwerk" }] };
	const label = (id: number, login: string, event = "labeled") => ({
		id,
		event,
		label: { name: "use-leitwerk" },
		actor: { login },
	});
	function client(events: unknown[], membershipStatus = 204, candidate = issue) {
		const fetch = vi.fn(async (url: string) => {
			if (url.includes("/members/")) return new Response(null, { status: membershipStatus });
			return new Response(JSON.stringify(url.includes("/events") ? events : candidate), {
				status: 200,
			});
		});
		vi.stubGlobal("fetch", fetch);
		return {
			fetch,
			api: new GitHubClient({
				apiBaseUrl: "https://api.github.com",
				token: "secret",
				botLogin: "bot",
				allowedOrganization: "leitwerk-dev",
			}),
		};
	}
	it("checks the latest label actor rather than the issue author", async () => {
		const f = client([label(1, "member"), label(2, "outsider")], 404);
		expect(
			await f.api.authorizedTrigger("leitwerk-dev", "test", 1, "use-leitwerk", "leitwerk-done"),
		).toBeNull();
		expect(f.fetch).toHaveBeenLastCalledWith(
			expect.stringContaining("/members/outsider"),
			expect.anything(),
		);
	});
	it("requires a currently active label event", async () => {
		const f = client([label(1, "member"), label(2, "member", "unlabeled")]);
		expect(
			await f.api.authorizedTrigger("leitwerk-dev", "test", 1, "use-leitwerk", "leitwerk-done"),
		).toBeNull();
	});
	it("fails closed on missing history or GitHub permission errors", async () => {
		expect(
			await client([]).api.authorizedTrigger(
				"leitwerk-dev",
				"test",
				1,
				"use-leitwerk",
				"leitwerk-done",
			),
		).toBeNull();
		await expect(
			client([label(1, "member")], 403).api.authorizedTrigger(
				"leitwerk-dev",
				"test",
				1,
				"use-leitwerk",
				"leitwerk-done",
			),
		).rejects.toThrow("403");
	});
	it("does not consider repositories outside the organization", async () => {
		const f = client([label(1, "member")]);
		expect(
			await f.api.authorizedTrigger("outsider", "test", 1, "use-leitwerk", "leitwerk-done"),
		).toBeNull();
		expect(f.fetch).not.toHaveBeenCalled();
	});
});

describe("GitHub feedback edit provenance", () => {
	const createdAt = "2026-09-08T08:00:00Z";
	const editedAt = "2026-09-08T08:01:00Z";
	const kinds = ["conversation", "review", "inline"] as const;
	const nodeTypes = {
		conversation: "IssueComment",
		review: "PullRequestReview",
		inline: "PullRequestReviewComment",
	};
	function fixture(
		kind: (typeof kinds)[number],
		snapshot: Record<string, unknown> | null,
		options: { unchanged?: boolean; membershipStatus?: number; graphqlErrors?: boolean } = {},
	) {
		const rest = {
			id: 42,
			node_id: "feedback-node",
			body: "REST body must not be trusted after an edit",
			user: { login: "original-member" },
			...(kind === "review"
				? { submitted_at: createdAt }
				: { created_at: createdAt, updated_at: options.unchanged ? createdAt : editedAt }),
		};
		const fetch = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.includes("/members/")) {
				return new Response(null, { status: options.membershipStatus ?? 204 });
			}
			if (url.endsWith("/graphql")) {
				expect(JSON.parse(String(init?.body)).variables.ids).toEqual(["feedback-node"]);
				return new Response(
					JSON.stringify(
						options.graphqlErrors
							? { errors: [{ message: "private API details" }] }
							: { data: { nodes: [snapshot] } },
					),
				);
			}
			const endpointKind = url.includes("/reviews?")
				? "review"
				: url.includes("/issues/")
					? "conversation"
					: "inline";
			return new Response(JSON.stringify(endpointKind === kind ? [rest] : []));
		});
		vi.stubGlobal("fetch", fetch);
		const client = new GitHubClient({
			apiBaseUrl: "https://api.github.com",
			token: "secret",
			botLogin: "bot",
			allowedOrganization: "leitwerk-dev",
		});
		return { fetch, read: () => client.listPullRequestFeedback("leitwerk-dev", "test", 1) };
	}
	function snapshot(kind: (typeof kinds)[number], overrides: Record<string, unknown> = {}) {
		return {
			id: "feedback-node",
			__typename: nodeTypes[kind],
			body: "Body from the same snapshot as the editor",
			author: { login: "original-member" },
			editor: { login: "latest-editor" },
			createdAt,
			submittedAt: createdAt,
			lastEditedAt: editedAt,
			...overrides,
		};
	}

	it.each(
		kinds,
	)("rejects %s feedback edited by a nonmember despite its member author", async (kind) => {
		const f = fixture(kind, snapshot(kind), { membershipStatus: 404 });
		expect(await f.read()).toEqual([]);
		expect(f.fetch).toHaveBeenCalledWith(
			expect.stringContaining("/members/latest-editor"),
			expect.anything(),
		);
	});

	it.each(
		kinds,
	)("keeps %s feedback edited by a member using the verified snapshot body", async (kind) => {
		const f = fixture(kind, snapshot(kind));
		expect(await f.read()).toEqual([
			{
				kind,
				id: 42,
				body: "Body from the same snapshot as the editor",
				author: "original-member",
				createdAt: editedAt,
			},
		]);
	});

	it("preserves unedited review summaries despite missing REST edit timestamps", async () => {
		const f = fixture("review", snapshot("review", { lastEditedAt: null, editor: null }));
		expect(await f.read()).toEqual([
			expect.objectContaining({
				kind: "review",
				createdAt,
				body: "Body from the same snapshot as the editor",
			}),
		]);
		expect(f.fetch.mock.calls.some(([url]) => url.includes("/members/"))).toBe(false);
	});

	it("reads unedited comments without a GraphQL request", async () => {
		const f = fixture("conversation", null, { unchanged: true });
		expect(await f.read()).toEqual([
			expect.objectContaining({
				kind: "conversation",
				createdAt,
				body: "REST body must not be trusted after an edit",
			}),
		]);
		expect(f.fetch.mock.calls.some(([url]) => url.endsWith("/graphql"))).toBe(false);
	});

	it.each([
		{ lastEditedAt: undefined },
		{ lastEditedAt: "invalid" },
		{ editor: null },
		{ submittedAt: null },
	])("skips review summaries with missing or invalid provenance: %j", async (overrides) => {
		expect(await fixture("review", snapshot("review", overrides)).read()).toEqual([]);
	});

	it("fails closed without exposing GraphQL error details", async () => {
		await expect(fixture("review", null, { graphqlErrors: true }).read()).rejects.toThrow(
			"GitHub feedback provenance lookup failed",
		);
	});

	it("fails closed when the latest editor's membership cannot be checked", async () => {
		await expect(
			fixture("review", snapshot("review"), { membershipStatus: 503 }).read(),
		).rejects.toThrow("GitHub membership check failed with 503");
	});
});
