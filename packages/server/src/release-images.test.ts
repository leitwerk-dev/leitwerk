import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("release image definitions", () => {
	for (const image of ["server", "worker-generic"]) {
		it(`${image} isolates dependency installation from source copies`, () => {
			const dockerfile = readFileSync(`${repoRoot}/deploy/images/Dockerfile.${image}`, "utf8");
			const manifestCopy = dockerfile.indexOf("COPY --parents");
			const install = dockerfile.indexOf("npm ci");
			const buildStage = dockerfile.indexOf("FROM dependencies AS build");
			const scriptsCopy = dockerfile.indexOf("COPY scripts ./scripts");
			const build = dockerfile.indexOf("RUN npm run build");

			expect(manifestCopy).toBeGreaterThan(-1);
			expect(install).toBeGreaterThan(manifestCopy);
			expect(buildStage).toBeGreaterThan(install);
			expect(scriptsCopy).toBeGreaterThan(buildStage);
			expect(build).toBeGreaterThan(scriptsCopy);
			expect(dockerfile).toContain("packages/*/package.json");
			expect(dockerfile).toContain("extensions/*/package.json");
		});

		it(`${image} pins every Node base stage by multi-architecture digest`, () => {
			const dockerfile = readFileSync(`${repoRoot}/deploy/images/Dockerfile.${image}`, "utf8");
			const fromLines = dockerfile.split("\n").filter((line) => line.startsWith("FROM node:"));
			expect(fromLines.length).toBeGreaterThan(0);
			expect(fromLines.every((line) => /@sha256:[a-f0-9]{64} AS /u.test(line))).toBe(true);
		});
	}
});
