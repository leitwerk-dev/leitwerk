import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("release image definitions", () => {
	for (const image of ["server", "worker-generic"]) {
		it(`${image} pins every Node base stage by multi-architecture digest`, () => {
			const dockerfile = readFileSync(`${repoRoot}/deploy/images/Dockerfile.${image}`, "utf8");
			const fromLines = dockerfile.split("\n").filter((line) => line.startsWith("FROM node:"));
			expect(fromLines.length).toBeGreaterThan(0);
			expect(fromLines.every((line) => /@sha256:[a-f0-9]{64} AS /u.test(line))).toBe(true);
		});
	}
});
