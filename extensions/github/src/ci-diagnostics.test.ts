import { afterEach, expect, it, vi } from "vitest";
import { GitHubClient } from "./client.js";

afterEach(() => vi.unstubAllGlobals());
it("correlates diagnostics with the PR revision and bounds signed job logs without forwarding credentials", async () => {
	const head = "a".repeat(40);
	const pr = { state: "open", merged: false, head: { sha: head, ref: "feature" } };
	const request = vi.fn(async (url: URL | Request | string, init?: RequestInit) => {
		const u = new URL(String(url));
		if (u.hostname === "logs.test") {
			expect(init?.headers).toBeUndefined();
			return new Response("x".repeat(70000));
		}
		if (u.pathname.endsWith("/pulls/1")) return Response.json(pr);
		if (u.pathname.endsWith("/check-runs"))
			return Response.json({
				check_runs: [
					{ id: 12, name: "tests", conclusion: "failure", output: { summary: "Assertion failed" } },
				],
			});
		if (u.pathname.endsWith("/annotations"))
			return Response.json([{ path: "test.ts", message: "Mismatch" }]);
		if (u.pathname.endsWith("/actions/runs"))
			return Response.json({
				workflow_runs: [
					{ id: 23, head_sha: head, head_branch: "feature", conclusion: "failure" },
					{ id: 99, head_sha: "stale", head_branch: "other", conclusion: "failure" },
				],
			});
		if (u.pathname.endsWith("/runs/23/jobs"))
			return Response.json({
				jobs: [
					{ id: 34, name: "test", html_url: "https://github.test/job/34", conclusion: "failure" },
				],
			});
		if (u.pathname.endsWith("/jobs/34/logs")) {
			expect(init?.redirect).toBe("manual");
			return new Response(null, { status: 302, headers: { location: "https://logs.test/signed" } });
		}
		throw new Error(`Unexpected endpoint ${u.pathname}`);
	});
	vi.stubGlobal("fetch", request);
	const client = new GitHubClient({
		apiBaseUrl: "https://api.github.test",
		token: "secret",
		botLogin: "bot",
	});
	const result = await client.getCiDiagnostics("team", "repo", 1, head);
	expect(result.checks[0].annotations).toHaveLength(1);
	expect(result.jobs).toHaveLength(1);
	expect(result.jobs[0].log).toEqual({ text: "x".repeat(65536), truncated: true });
	request.mockClear();
	await expect(client.getCiDiagnostics("team", "repo", 1, "stale")).rejects.toThrow("stale");
	expect(request).toHaveBeenCalledTimes(1);
});
