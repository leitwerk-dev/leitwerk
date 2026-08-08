import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	releaseAppBotSignoff,
	renderReleasePleaseConfig,
} from "./render-release-please-config.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Release Please App identity", () => {
	it("uses the GitHub App bot's exact no-reply identity for DCO", () => {
		expect(releaseAppBotSignoff("123456", "leitwerk-release")).toBe(
			"leitwerk-release[bot] <123456+leitwerk-release[bot]@users.noreply.github.com>",
		);
	});

	it("renders the sign-off only into the ephemeral workflow config", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "leitwerk-release-config-"));
		temporaryDirectories.push(directory);
		const sourcePath = path.join(directory, "source.json");
		const destinationPath = path.join(directory, "runtime.json");
		writeFileSync(sourcePath, '{"packages":{".":{}}}\n');

		renderReleasePleaseConfig({
			sourcePath,
			destinationPath,
			appId: "123456",
			appSlug: "leitwerk-release",
		});

		expect(JSON.parse(readFileSync(destinationPath, "utf8"))).toMatchObject({
			signoff: "leitwerk-release[bot] <123456+leitwerk-release[bot]@users.noreply.github.com>",
		});
		expect(JSON.parse(readFileSync(sourcePath, "utf8"))).not.toHaveProperty("signoff");
	});
});
