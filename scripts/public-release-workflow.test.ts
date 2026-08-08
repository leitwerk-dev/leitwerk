import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function workflow(name: string) {
	return parse(readFileSync(`${repoRoot}/.github/workflows/${name}`, "utf8")) as Record<
		string,
		unknown
	>;
}

describe("Release Please workflow", () => {
	it("ordinary main pushes only maintain the release PR or complete its release", () => {
		const text = readFileSync(`${repoRoot}/.github/workflows/release-please.yml`, "utf8");
		const parsed = workflow("release-please.yml");
		const jobs = parsed.jobs as Record<string, Record<string, unknown>>;
		const steps = jobs["release-please"].steps as Array<Record<string, unknown>>;

		expect(parsed.on).toEqual({ push: { branches: ["main"] } });
		expect(steps.map((step) => step.name)).toEqual([
			"Create narrow GitHub App token",
			"Checkout",
			"Render matching App bot DCO sign-off",
			"Update release PR or create release",
		]);
		expect(text).toContain("RELEASE_PLEASE_APP_ID");
		expect(text).toContain("RELEASE_PLEASE_APP_PRIVATE_KEY");
		expect(text).not.toContain("npm publish");
		expect(text).not.toContain("docker/build-push-action");
	});
});

describe("public release workflow", () => {
	it("publishes all lockstep artifacts from Release Please tags", () => {
		const text = readFileSync(`${repoRoot}/.github/workflows/publish.yml`, "utf8");
		const parsed = workflow("publish.yml");
		const jobs = parsed.jobs as Record<string, Record<string, unknown>>;
		const publish = jobs.publish;
		const permissions = publish.permissions as Record<string, string>;
		const steps = publish.steps as Array<Record<string, unknown>>;
		const stepNames = steps.map((step) => step.name);

		expect(permissions).toMatchObject({
			contents: "write",
			"id-token": "write",
			packages: "write",
		});
		expect(stepNames).toEqual(
			expect.arrayContaining([
				"Preflight npm publication",
				"Inspect existing image tags",
				"Build and publish multi-architecture server image",
				"Build and publish multi-architecture generic worker image",
				"Package, publish, or reuse digest-pinned Helm chart",
				"Publish missing npm packages",
				"Verify anonymous reads and multi-architecture manifests",
				"Attach public release assets",
			]),
		);
		expect(text).toContain("platforms: linux/amd64,linux/arm64");
		expect(text).toContain("npm run test:full");
		expect(text).toContain("npm run docs:build");
		expect(text).toContain("npm run publish:dry-run");
		expect(text).toContain("npm@11.16.0");
		expect(text).not.toContain("NPM_TOKEN");
		expect(text).not.toMatch(/leitwerk-(?:server|worker-generic):(?:latest|v?\d+\.?\$)/u);
	});

	it("supports conflict-aware retries for an existing release tag", () => {
		const text = readFileSync(`${repoRoot}/.github/workflows/publish.yml`, "utf8");
		const npmPublisher = readFileSync(`${repoRoot}/scripts/publish-workspaces.mjs`, "utf8");
		const parsed = workflow("publish.yml");
		const dispatch = (parsed.on as Record<string, unknown>).workflow_dispatch as Record<
			string,
			unknown
		>;

		expect(dispatch).toHaveProperty("inputs.release_tag.required", true);
		expect(text).toContain("Release lock belongs to Git revision");
		expect(npmPublisher).toContain("already exists for Git revision");
		expect(text).toContain("helm pull");
		expect(npmPublisher).toContain("it will not be republished");
		expect(text).toContain("npm run publish:verify");
	});

	it("pins every third-party action to a full commit SHA", () => {
		for (const file of ["ci.yml", "policy.yml", "publish.yml", "release-please.yml"]) {
			const text = readFileSync(`${repoRoot}/.github/workflows/${file}`, "utf8");
			for (const match of text.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gmu)) {
				expect(match[1], `${file}: ${match[1]}`).toMatch(/@[a-f0-9]{40}$/u);
			}
		}
	});
});
