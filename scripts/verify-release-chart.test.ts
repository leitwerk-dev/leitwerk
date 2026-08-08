import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReleaseChart } from "./verify-release-chart.js";

const temporaryDirectories: string[] = [];
const serverDigest = `sha256:${"a".repeat(64)}`;
const workerDigest = `sha256:${"b".repeat(64)}`;
const gitSha = "c".repeat(40);

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("release chart retry verification", () => {
	it("accepts an existing chart only for the same Git revision and image digests", () => {
		const chartDir = mkdtempSync(path.join(tmpdir(), "leitwerk-existing-chart-"));
		temporaryDirectories.push(chartDir);
		writeFileSync(
			path.join(chartDir, "Chart.yaml"),
			`version: 1.2.3\nappVersion: 1.2.3\nannotations:\n  leitwerk.dev/git-sha: ${gitSha}\n  leitwerk.dev/server-image-digest: ${serverDigest}\n  leitwerk.dev/worker-image-digest: ${workerDigest}\n`,
		);
		writeFileSync(
			path.join(chartDir, "values.yaml"),
			`server:\n  image:\n    repository: ghcr.io/leitwerk-dev/leitwerk-server\n    digest: ${serverDigest}\nworkerRuntimeProfiles:\n  generic:\n    image: ghcr.io/leitwerk-dev/leitwerk-worker-generic@${workerDigest}\n`,
		);

		expect(
			verifyReleaseChart({ chartDir, version: "1.2.3", gitSha, serverDigest, workerDigest }),
		).toEqual([]);
		expect(
			verifyReleaseChart({
				chartDir,
				version: "1.2.3",
				gitSha: "d".repeat(40),
				serverDigest,
				workerDigest,
			}),
		).toContain(`Chart Git SHA must be ${"d".repeat(40)}`);
	});
});
