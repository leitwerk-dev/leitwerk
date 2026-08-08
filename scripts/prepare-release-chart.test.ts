import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { prepareReleaseChart } from "./prepare-release-chart.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectories: string[] = [];
const digest = `sha256:${"a".repeat(64)}`;

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("prepareReleaseChart", () => {
	it("stages a chart whose default server and worker images are digest-pinned", () => {
		const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "leitwerk-release-chart-"));
		temporaryDirectories.push(temporaryDirectory);
		const destinationDir = path.join(temporaryDirectory, "leitwerk");

		prepareReleaseChart({
			sourceDir: path.join(repoRoot, "deploy/kubernetes/helm/leitwerk"),
			destinationDir,
			version: "1.2.3-rc.1+build.7",
			gitSha: "b".repeat(40),
			serverImage: `ghcr.io/leitwerk-dev/leitwerk-server@${digest}`,
			workerImage: `ghcr.io/leitwerk-dev/leitwerk-worker-generic@${digest}`,
		});

		const chart = parse(readFileSync(path.join(destinationDir, "Chart.yaml"), "utf8"));
		const values = parse(readFileSync(path.join(destinationDir, "values.yaml"), "utf8"));
		expect(chart).toMatchObject({
			version: "1.2.3-rc.1+build.7",
			appVersion: "1.2.3-rc.1+build.7",
			annotations: {
				"leitwerk.dev/git-sha": "b".repeat(40),
				"leitwerk.dev/server-image-digest": digest,
				"leitwerk.dev/worker-image-digest": digest,
			},
		});
		expect(values).toMatchObject({
			server: {
				image: {
					repository: "ghcr.io/leitwerk-dev/leitwerk-server",
					tag: "1.2.3-rc.1+build.7",
					digest,
				},
			},
			workerRuntimeProfiles: {
				generic: { image: `ghcr.io/leitwerk-dev/leitwerk-worker-generic@${digest}` },
			},
		});
	});

	it("rejects mutable image references", () => {
		expect(() =>
			prepareReleaseChart({
				sourceDir: path.join(repoRoot, "deploy/kubernetes/helm/leitwerk"),
				destinationDir: path.join(tmpdir(), "unused-release-chart"),
				version: "1.2.3",
				gitSha: "b".repeat(40),
				serverImage: "ghcr.io/leitwerk-dev/leitwerk-server:1.2.3",
				workerImage: `ghcr.io/leitwerk-dev/leitwerk-worker-generic@${digest}`,
			}),
		).toThrow("Server image must be digest-pinned");
	});
});
