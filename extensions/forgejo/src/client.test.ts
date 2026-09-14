import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgejoClient, parseForgejoProfiles, parseForgejoTicketCreationConfig } from "./client.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ForgejoClient", () => {
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
				ticket_creation: { default_labels: ["bot", "triage", "bot"] },
			}),
		).toEqual({ defaultLabels: ["bot", "triage"] });
		expect(() =>
			parseForgejoTicketCreationConfig({ ticket_creation: { default_labels: [""] } }),
		).toThrow(/default_labels/);
	});

	it("resolves the authenticated bot identity from the configured profile", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ login: "leitwerk-bot", full_name: "Leitwerk Bot" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			),
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
		const requests: Array<{ url: string; init: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit = {}) => {
				requests.push({ url, init });
				return new Response(JSON.stringify({ number: 7, labels: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);
		const client = new ForgejoClient({
			baseUrl: "https://git.example.test",
			token: "token",
			botLogin: "leitwerk",
		});

		await client.updateIssue("team", "repo", 7, {
			labels: [2, 3],
			state: "closed",
		});

		expect(requests.map((request) => [request.init.method, request.url])).toEqual([
			["PUT", "https://git.example.test/api/v1/repos/team/repo/issues/7/labels"],
			["PATCH", "https://git.example.test/api/v1/repos/team/repo/issues/7"],
		]);
		expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
			labels: [2, 3],
		});
		expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
			state: "closed",
		});
	});

	it("creates issues with Forgejo label ids", async () => {
		const requests: Array<{ url: string; init: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit = {}) => {
				requests.push({ url, init });
				return new Response(
					JSON.stringify({
						number: 7,
						title: "Ticket",
						body: "Description",
						state: "open",
						html_url: "https://git.example.test/team/repo/issues/7",
						updated_at: "2026-08-23T00:00:00Z",
						user: { login: "leitwerk" },
						labels: [],
					}),
					{ status: 201, headers: { "Content-Type": "application/json" } },
				);
			}),
		);
		const client = new ForgejoClient({
			baseUrl: "https://git.example.test",
			token: "token",
			botLogin: "leitwerk",
		});

		await client.createIssue("team", "repo", {
			title: "Ticket",
			body: "Description",
			labels: [3, 5],
		});

		expect(requests[0]?.url).toBe("https://git.example.test/api/v1/repos/team/repo/issues");
		expect(requests[0]?.init.method).toBe("POST");
		expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
			title: "Ticket",
			body: "Description",
			labels: [3, 5],
		});
	});

	it("normalizes conversation, submitted review, and nested inline feedback", async () => {
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				urls.push(url);
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
				return new Response(JSON.stringify(body), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);
		const client = new ForgejoClient({
			baseUrl: "https://git.example.test",
			token: "token",
			botLogin: "leitwerk",
		});

		const feedback = await client.listPullRequestFeedback("team", "repo", 9);

		expect(feedback).toMatchObject([
			{ kind: "conversation", id: 10, author: "alice" },
			{
				kind: "review",
				id: 20,
				author: "bob",
				createdAt: "2026-08-10T10:01:00Z",
			},
			{
				kind: "inline",
				id: 30,
				author: "carol",
				path: "src/a.ts",
				line: 4,
				position: 4,
				reviewId: 20,
			},
		]);
		expect(urls.some((url) => url.includes("/pulls/9/reviews/20/comments"))).toBe(true);
		expect(urls.some((url) => url.includes("/pulls/9/comments"))).toBe(false);
	});

	it("adds eyes and replies in the exact inline review", async () => {
		const requests: Array<{ url: string; init: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit = {}) => {
				requests.push({ url, init });
				return new Response(JSON.stringify({ id: 1 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);
		const client = new ForgejoClient({
			baseUrl: "https://git.example.test",
			token: "token",
			botLogin: "leitwerk",
		});

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

		expect(requests.map((request) => [request.init.method, request.url])).toEqual([
			["POST", "https://git.example.test/api/v1/repos/team/repo/issues/comments/30/reactions"],
			["POST", "https://git.example.test/api/v1/repos/team/repo/pulls/9/reviews/20/comments"],
		]);
		expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
			content: "eyes",
		});
		expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
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
				return new Response(JSON.stringify(body), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);
		const client = new ForgejoClient({
			baseUrl: "https://git.example.test",
			token: "token",
			botLogin: "leitwerk",
		});

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
