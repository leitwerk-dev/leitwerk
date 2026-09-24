import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgejoClient, parseForgejoProfiles, parseForgejoTicketCreationConfig } from "./client.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ForgejoClient", () => {
	const client = new ForgejoClient({
		baseUrl: "https://git.example.test",
		token: "token",
		botLogin: "leitwerk",
	});
	it("retains Forgejo encoding, authentication and cancellation for shared PR endpoints", async () => {
		const fetch = vi.fn(async () => Response.json({ number: 7 }));
		vi.stubGlobal("fetch", fetch);
		const signal = new AbortController().signal;
		await client.getPullRequest("a/b", "c d", 7, signal);
		expect(fetch).toHaveBeenCalledWith(
			"https://git.example.test/api/v1/repos/a%2Fb/c%20d/pulls/7",
			expect.objectContaining({
				signal,
				headers: expect.objectContaining({ Authorization: "token token" }),
			}),
		);
		fetch.mockImplementation(async () => Response.json([]));
		await client.listPullRequests("a/b", "c d", "open&state=closed");
		expect(fetch).toHaveBeenLastCalledWith(
			"https://git.example.test/api/v1/repos/a%2Fb/c%20d/pulls?state=open%26state%3Dclosed&limit=50&page=1",
			expect.anything(),
		);
	});

	it("validates server-owned profiles", () => {
		const profiles = parseForgejoProfiles({
			profiles: {
				primary: {
					base_url: "https://git.example.test/",
					token: " secret ",
				},
			},
		});
		expect(profiles.get("primary")).toEqual({
			baseUrl: "https://git.example.test",
			token: "secret",
			botLogin: "leitwerk",
		});
		expect(() =>
			parseForgejoProfiles({
				profiles: { bad: { base_url: "http://git", token: "x" } },
			}),
		).toThrow(/HTTPS/);
	});

	it("parses ticket creation default labels", () => {
		expect(parseForgejoTicketCreationConfig({})).toEqual({
			defaultLabels: ["created-by-leitwerk"],
		});
		expect(
			parseForgejoTicketCreationConfig({
				ticket_creation: { default_labels: [" bot ", "triage", "bot"] },
			}),
		).toEqual({ defaultLabels: ["bot", "triage"] });
		expect(() =>
			parseForgejoTicketCreationConfig({ ticket_creation: { default_labels: [""] } }),
		).toThrow(/default_labels/);
	});

	it("resolves the authenticated bot identity from the configured profile", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ login: "leitwerk-bot", full_name: "Leitwerk Bot" })),
		);
		const client = new ForgejoClient({
			baseUrl: "https://git.example.test",
			token: "token",
			botLogin: "leitwerk-bot",
		});

		await expect(client.resolveGitIdentity("primary")).resolves.toEqual({
			name: "Leitwerk Bot",
			email: "leitwerk-bot@noreply.git.example.test",
			provider: "forgejo",
			profile: "primary",
			login: "leitwerk-bot",
		});
	});

	it("uses the Forgejo 11 labels endpoint separately from issue edits", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ number: 7, labels: [] }),
		);
		vi.stubGlobal("fetch", fetch);
		const signal = new AbortController().signal;
		await client.updateIssue("team", "repo", 7, { labels: [2, 3], state: "closed" }, signal);
		expect(fetch.mock.calls.every(([, init]) => init?.signal === signal)).toBe(true);

		expect(fetch.mock.calls.map(([url, init]) => [init?.method, url])).toEqual([
			["PUT", "https://git.example.test/api/v1/repos/team/repo/issues/7/labels"],
			["PATCH", "https://git.example.test/api/v1/repos/team/repo/issues/7"],
		]);
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
			labels: [2, 3],
		});
		expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
			state: "closed",
		});
	});

	it("creates issues with Forgejo label ids", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ number: 7 }, { status: 201 }),
		);
		vi.stubGlobal("fetch", fetch);
		await client.createIssue("team", "repo", {
			title: "Ticket",
			body: "Description",
			labels: [3, 5],
		});

		expect(fetch.mock.calls[0]?.[0]).toBe("https://git.example.test/api/v1/repos/team/repo/issues");
		expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
			title: "Ticket",
			body: "Description",
			labels: [3, 5],
		});
	});

	it("normalizes conversation, submitted review, and nested inline feedback", async () => {
		const fetch = vi.fn(async (url: string) => {
			const body = url.includes("/issues/9/comments")
				? [
						{
							id: 10,
							body: "Conversation",
							created_at: "2026-08-10T10:00:00Z",
							user: { login: "alice" },
						},
					]
				: url.includes("/reviews/20/comments")
					? [
							{
								id: 30,
								body: "Inline",
								created_at: "2026-08-10T10:02:00Z",
								user: { login: "carol" },
								path: "src/a.ts",
								line: 4,
								position: 4,
							},
						]
					: [
							{
								id: 20,
								body: "Review",
								submitted_at: "2026-08-10T10:01:00Z",
								user: { login: "bob" },
							},
						];
			return Response.json(body);
		});
		vi.stubGlobal("fetch", fetch);
		const feedback = await client.listPullRequestFeedback("team", "repo", 9);

		expect(feedback).toMatchObject([
			{
				kind: "conversation",
				id: 10,
				author: "alice",
				body: "Conversation",
				createdAt: "2026-08-10T10:00:00Z",
			},
			{
				kind: "review",
				id: 20,
				author: "bob",
				body: "Review",
				createdAt: "2026-08-10T10:01:00Z",
			},
			{
				kind: "inline",
				id: 30,
				author: "carol",
				body: "Inline",
				createdAt: "2026-08-10T10:02:00Z",
				path: "src/a.ts",
				line: 4,
				position: 4,
				reviewId: 20,
			},
		]);
		expect(fetch.mock.calls.some(([url]) => url.includes("/pulls/9/reviews/20/comments"))).toBe(
			true,
		);
		expect(fetch.mock.calls.some(([url]) => url.includes("/pulls/9/comments"))).toBe(false);
	});

	it("adds eyes and replies in the exact inline review", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ id: 1 }));
		vi.stubGlobal("fetch", fetch);
		const feedback = {
			kind: "inline" as const,
			id: 30,
			body: "shorten this",
			createdAt: "2026-08-10T10:02:00Z",
			author: "carol",
			path: "README.md",
			position: 4,
			reviewId: 20,
		};
		await client.addPullRequestFeedbackReaction("team", "repo", feedback, "eyes");
		await client.replyToPullRequestFeedback("team", "repo", 9, feedback, "Addressed.");

		expect(fetch.mock.calls.map(([url, init]) => [init?.method, url])).toEqual([
			["POST", "https://git.example.test/api/v1/repos/team/repo/issues/comments/30/reactions"],
			["POST", "https://git.example.test/api/v1/repos/team/repo/pulls/9/reviews/20/comments"],
		]);
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
			content: "eyes",
		});
		expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
			body: "Addressed.",
			path: "README.md",
			new_position: 4,
			old_position: 0,
			extra_lines_count: 0,
		});
	});

	it("replies to distinct old-side and new-side threads in the same file", async () => {
		const comments = [
			{ id: 155, position: 0, original_position: 127, extra_lines_count: 0 },
			{ id: 156, position: 0, original_position: 56, extra_lines_count: 0 },
			{ id: 157, position: 127, original_position: 0, extra_lines_count: 0 },
			{ id: 158, position: 0, original_position: 80, extra_lines_count: 3 },
			{ id: 159, position: 80, original_position: 0, extra_lines_count: 3 },
		].map((comment) => ({
			...comment,
			body: `Feedback ${comment.id}`,
			created_at: "2026-09-09T14:16:32Z",
			user: { login: "reviewer" },
			path: "app/lib/l10n/app_localizations.dart",
		}));
		const replies: unknown[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit = {}) => {
				let body: unknown;
				if (url.includes("/reviews/5/comments")) {
					if (init.method === "POST") {
						replies.push(JSON.parse(String(init.body)));
						body = { id: 200 + replies.length };
					} else {
						body = comments;
					}
				} else if (url.includes("/pulls/14/reviews")) {
					body = [{ id: 5 }];
				} else if (url.includes("/issues/14/comments")) {
					body = [];
				} else {
					throw new Error(`Unexpected request: ${url}`);
				}
				return Response.json(body);
			}),
		);
		for (const feedback of await client.listPullRequestFeedback("team", "repo", 14)) {
			await client.replyToPullRequestFeedback("team", "repo", 14, feedback, "Addressed.");
		}

		expect(replies).toEqual(
			[
				{ new_position: 0, old_position: 127, extra_lines_count: 0 },
				{ new_position: 0, old_position: 56, extra_lines_count: 0 },
				{ new_position: 127, old_position: 0, extra_lines_count: 0 },
				{ new_position: 0, old_position: 80, extra_lines_count: 3 },
				{ new_position: 80, old_position: 0, extra_lines_count: 3 },
			].map((coordinates) => ({
				body: "Addressed.",
				path: "app/lib/l10n/app_localizations.dart",
				...coordinates,
			})),
		);
	});
});
