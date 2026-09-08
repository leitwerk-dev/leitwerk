import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validateReleaseOrigin, verifyReleaseOrigin } from "./verify-release-origin.mjs";

function releaseOrigin() {
	return {
		repository: "leitwerk-dev/leitwerk",
		tag: "v0.2.0",
		sha: "a".repeat(40),
		release: {
			tag_name: "v0.2.0",
			draft: false,
			prerelease: false,
			author: { login: "github-actions[bot]" },
		},
		comparison: { status: "ahead" },
		pull: {
			number: 40,
			merged_at: "2026-09-08T10:00:00Z",
			merge_commit_sha: "a".repeat(40),
			user: { login: "github-actions[bot]" },
			head: { ref: "release-please--branches--main", repo: { full_name: "leitwerk-dev/leitwerk" } },
			base: { ref: "main", repo: { full_name: "leitwerk-dev/leitwerk" } },
		},
	};
}

describe("stable release origin", () => {
	it.each(["ahead", "identical"])("accepts a merged release and its retries (%s)", (status) => {
		const input = releaseOrigin();
		input.comparison.status = status;
		expect(() => validateReleaseOrigin(input)).not.toThrow();
	});

	it.each([
		[
			"prerelease tag",
			(input) => {
				input.tag = "v0.2.0-rc.1";
			},
		],
		[
			"mismatched tag",
			(input) => {
				input.release.tag_name = "v0.1.9";
			},
		],
		[
			"draft release",
			(input) => {
				input.release.draft = true;
			},
		],
		[
			"prerelease",
			(input) => {
				input.release.prerelease = true;
			},
		],
		[
			"manually created release",
			(input) => {
				input.release.author.login = "maintainer";
			},
		],
		[
			"commit outside main",
			(input) => {
				input.comparison.status = "diverged";
			},
		],
		[
			"unmerged PR",
			(input) => {
				input.pull.merged_at = "";
			},
		],
		[
			"tag not at merge commit",
			(input) => {
				input.pull.merge_commit_sha = "b".repeat(40);
			},
		],
		[
			"human PR",
			(input) => {
				input.pull.user.login = "maintainer";
			},
		],
		[
			"ordinary PR",
			(input) => {
				input.pull.head.ref = "feature";
			},
		],
		[
			"fork PR",
			(input) => {
				input.pull.head.repo.full_name = "fork/leitwerk";
			},
		],
		[
			"wrong base",
			(input) => {
				input.pull.base.ref = "other";
			},
		],
		[
			"wrong repository",
			(input) => {
				input.pull.base.repo.full_name = "fork/leitwerk";
			},
		],
	] satisfies [
		string,
		(input: ReturnType<typeof releaseOrigin>) => void,
	][])("rejects %s", (_name, change) => {
		const input = releaseOrigin();
		change(input);
		expect(() => validateReleaseOrigin(input)).toThrow();
	});

	it("rejects a missing associated PR", () => {
		expect(() => validateReleaseOrigin({ ...releaseOrigin(), pull: undefined })).toThrow();
	});

	it.each([
		["refs/heads/feature", "workflow_dispatch"],
		["refs/tags/v0.2.0", "workflow_dispatch"],
		["refs/heads/main", "pull_request"],
	])("rejects dispatch context %s / %s before accessing GitHub", async (ref, event) => {
		await expect(
			verifyReleaseOrigin({ GITHUB_REF: ref, GITHUB_EVENT_NAME: event }),
		).rejects.toThrow("Publication must be dispatched from main");
	});

	it.each([
		false,
		true,
	])("resolves GitHub metadata and pins the verified commit (annotated=%s)", async (annotated) => {
		const input = releaseOrigin();
		const prefix = `/repos/${input.repository}/`;
		const requests: string[] = [];
		const responses: Record<string, unknown> = {
			[`releases/tags/${input.tag}`]: input.release,
			[`git/ref/tags/${input.tag}`]: {
				object: { type: annotated ? "tag" : "commit", sha: input.sha },
			},
			[`git/tags/${input.sha}`]: { object: { type: "commit", sha: input.sha } },
			[`compare/${input.sha}...main`]: input.comparison,
			[`commits/${input.sha}/pulls?per_page=100&page=1`]: [input.pull],
		};
		const server = createServer((request, response) => {
			const endpoint = request.url?.slice(prefix.length) ?? "";
			requests.push(endpoint);
			response.writeHead(endpoint in responses ? 200 : 404, { "Content-Type": "application/json" });
			response.end(JSON.stringify(responses[endpoint] ?? {}));
		});
		const directory = mkdtempSync(path.join(tmpdir(), "leitwerk-release-origin-"));
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const output = path.join(directory, "output");
			await verifyReleaseOrigin({
				GITHUB_REF: "refs/heads/main",
				GITHUB_EVENT_NAME: "workflow_dispatch",
				GITHUB_REPOSITORY: input.repository,
				GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
				GH_TOKEN: "test-token",
				RELEASE_TAG: input.tag,
				GITHUB_OUTPUT: output,
			});
			expect(readFileSync(output, "utf8")).toBe(`git_sha=${input.sha}\n`);
			expect(requests.includes(`git/tags/${input.sha}`)).toBe(annotated);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("verifies origin using trusted tooling before checking out release code", () => {
		const filename = fileURLToPath(new URL("../.github/workflows/publish.yml", import.meta.url));
		const workflow = parse(readFileSync(filename, "utf8"));
		const steps = workflow.jobs.resolve.steps;
		expect(steps[0].with.ref).toBe(`\${{ github.sha }}`);
		expect(steps[1].run).toBe("node .release-tooling/scripts/verify-release-origin.mjs");
		expect(steps[2].with.ref).toBe(`\${{ steps.origin.outputs.git_sha }}`);
		for (const name of ["validate", "build-images", "publish"]) {
			const checkout = workflow.jobs[name].steps.find((step: { uses?: string }) =>
				step.uses?.startsWith("actions/checkout@"),
			);
			expect(checkout.with.ref).toBe(`\${{ needs.resolve.outputs.git_sha }}`);
		}
		expect(workflow.jobs.publish.environment).toBe("npm-publish");
	});
});
