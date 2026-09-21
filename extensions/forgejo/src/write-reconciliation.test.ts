import {
	existingObject,
	IntegrationHttpError,
	type IntegrationToolExecutionContext,
	matchesPatch,
} from "@leitwerk-dev/process-sdk";
import { createInMemoryExternalWriteLog, createToolCollector } from "@leitwerk-dev/test-support";
import { afterEach, expect, it, vi } from "vitest";
import { ForgejoClient } from "./client.js";
import { registerForgejoTools } from "./tools.js";

afterEach(() => vi.unstubAllGlobals());
function fixture() {
	const writes = createInMemoryExternalWriteLog();
	const { api, tools } = createToolCollector(writes);

	const client = new ForgejoClient({
		baseUrl: "https://forge.test",
		token: "test",
		botLogin: "bot",
	});
	registerForgejoTools(api, { client: () => client, profiles: () => ["default"] });
	const ctx = {
		process: { id: "p" },
		project: {
			instanceId: "p",
			metadata: { forgejo: { owner: "team", repo: "repo", profile: "default" } },
		},
		idempotencyKey: "key",
		signal: new AbortController().signal,
	} as unknown as IntegrationToolExecutionContext;
	return {
		writes,
		run: (name: string, args: Record<string, unknown>) => {
			const tool = tools.get(name);
			if (!tool) throw new Error(name);
			return tool.execute(ctx, args);
		},
	};
}
function loseWriteResponse(
	path: string,
	remote: unknown,
	mutate: (body: Record<string, unknown>) => void,
	method = "POST",
) {
	const write = vi.fn(mutate);
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		expect(url).toContain(path);
		if (init.method === method) {
			write(JSON.parse(String(init.body)));
			throw new Error("lost response");
		}
		return Response.json(remote);
	});
	return write;
}
it("recovers a lost comment response with the marker, including logged replay", async () => {
	const f = fixture();
	const comments: Array<{ id: number; body: string }> = [];
	const post = loseWriteResponse("/repos/team/repo/issues/7/comments", comments, (body) => {
		comments.push({ id: 1, body: String(body.body) });
	});
	const args = { issueNumber: 7, body: "Addressed" };
	expect(await f.run("forgejo_add_issue_comment", args)).toMatchObject({ id: 1 });
	expect(comments[0].body).toContain("<!-- leitwerk-write:p:key -->");
	expect(await f.run("forgejo_add_issue_comment", args)).toMatchObject({ id: 1 });
	comments.length = 0;
	await expect(f.run("forgejo_add_issue_comment", args)).rejects.toMatchObject({
		name: "ExternalWriteMissingRemoteError",
	});
	expect(post).toHaveBeenCalledTimes(1);
});
it("rejects historical logged comments without a recoverable marker", async () => {
	const f = fixture();
	f.writes.record({ instanceId: "p", writeType: "forgejo.comment", dedupKey: "key" });
	const fetch = vi.fn(async () => Response.json([{ id: 1, body: "Old unmarked comment" }]));
	vi.stubGlobal("fetch", fetch);
	await expect(
		f.run("forgejo_add_issue_comment", { issueNumber: 7, body: "Old unmarked comment" }),
	).rejects.toMatchObject({ name: "ExternalWriteMissingRemoteError" });
	expect(fetch).toHaveBeenCalledTimes(1);
});
it("recovers only the bot's eyes reaction at the scoped comment endpoint", async () => {
	const f = fixture();
	const reactions = [{ content: "eyes", user: { login: "someone" } }];
	const post = loseWriteResponse("/repos/team/repo/issues/comments/8/reactions", reactions, () => {
		reactions.push({ content: "eyes", user: { login: "BOT" } });
	});
	const args = { pullRequestNumber: 7, feedbackKind: "inline", feedbackId: 8, writeKey: "key" };
	expect(await f.run("forgejo_add_pull_request_feedback_reaction", args)).toEqual({ ok: true });
	await f.run("forgejo_add_pull_request_feedback_reaction", args);
	expect(post).toHaveBeenCalledTimes(1);
});
it("compares requested fields after lost updates and preserves later edits", async () => {
	const f = fixture();
	const current = {
		title: "Old",
		labels: [
			{ id: 2, name: "two" },
			{ id: 1, name: "one" },
		],
		state: "closed",
	};
	const patch = loseWriteResponse(
		"/repos/team/repo/issues/7",
		current,
		() => Object.assign(current, { title: "Updated" }),
		"PATCH",
	);
	await f.run("forgejo_update_issue", { issueNumber: 7, patch: { title: "Updated" } });
	current.title = "Later edit";
	await f.run("forgejo_update_issue", { issueNumber: 7, patch: { title: "Updated" } });
	expect(current.title).toBe("Later edit");
	expect(patch).toHaveBeenCalledTimes(1);
	expect(matchesPatch(current, { labels: [1, 2], state: "closed" })).toBe(true);
	expect(matchesPatch(current, { labels: ["two", "one"] })).toBe(true);
	expect(matchesPatch(current, { title: "Updated" })).toBe(false);
});
it("treats only HTTP 404 as definitive absence", async () => {
	await expect(
		existingObject(async () => {
			throw new IntegrationHttpError(404, "missing");
		}),
	).resolves.toBeNull();
	for (const status of [401, 403, 500]) {
		const error = new IntegrationHttpError(status, "failed");
		await expect(
			existingObject(async () => {
				throw error;
			}),
		).rejects.toBe(error);
	}
});

it("recovers replies only in the original inline review and path", async () => {
	const f = fixture();
	let posts = 0;
	const parent = { id: 8, body: "Please fix", path: "a.ts", line: 2, user: { login: "reviewer" } };
	const marker = "<!-- leitwerk-write:p:key -->";
	const correct: Record<string, unknown>[] = [
		parent,
		{ ...parent, id: 11, line: 99, body: marker },
	];
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		if (url.includes("/reviews/1/comments")) {
			if (init.method === "POST") {
				posts++;
				correct.push({ ...parent, id: 9, body: JSON.parse(String(init.body)).body });
				throw new Error("lost response");
			}
			return Response.json(correct);
		}
		if (url.includes("/reviews/2/comments"))
			return Response.json([{ ...parent, id: 10, body: marker }]);
		if (url.includes("/reviews")) return Response.json([{ id: 1 }, { id: 2 }]);
		if (url.includes("/issues/7/comments")) return Response.json([{ ...parent, body: marker }]);
		throw new Error(`Unexpected request: ${url}`);
	});
	const args = {
		pullRequestNumber: 7,
		feedbackKind: "inline",
		feedbackId: 8,
		body: "Fixed",
		writeKey: "key",
	};
	await f.run("forgejo_reply_to_pull_request_feedback", args);
	await f.run("forgejo_reply_to_pull_request_feedback", args);
	expect(posts).toBe(1);
});
