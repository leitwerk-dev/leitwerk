import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("release image definitions", () => {
	it("uses Node 26 for the generic worker runtime", () => {
		const dockerfile = readFileSync(`${repoRoot}/deploy/images/Dockerfile.worker-generic`, "utf8");
		const runtimeBase = dockerfile
			.split("\n")
			.find((line) => line.startsWith("FROM node:") && line.endsWith(" AS runtime"));
		expect(runtimeBase).toMatch(/^FROM node:26-bookworm-slim@sha256:[a-f0-9]{64} AS runtime$/u);
	});

	it("pins mise for both release architectures and keeps the worker on its own Node", () => {
		const dockerfile = readFileSync(`${repoRoot}/deploy/images/Dockerfile.worker-generic`, "utf8");
		expect(dockerfile).toContain("ARG MISE_VERSION=2026.8.14");
		expect(dockerfile).toMatch(/amd64\) mise_arch=x64; mise_sha=[a-f0-9]{64}/u);
		expect(dockerfile).toMatch(/arm64\) mise_arch=arm64; mise_sha=[a-f0-9]{64}/u);
		expect(dockerfile).toContain('CMD ["/usr/local/bin/node", "dist/worker-entry.js"]');
	});

	for (const image of ["server", "worker-generic"]) {
		it(`${image} pins every Node base stage by multi-architecture digest`, () => {
			const dockerfile = readFileSync(`${repoRoot}/deploy/images/Dockerfile.${image}`, "utf8");
			const fromLines = dockerfile.split("\n").filter((line) => line.startsWith("FROM node:"));
			expect(fromLines.length).toBeGreaterThan(0);
			expect(fromLines.every((line) => /@sha256:[a-f0-9]{64} AS /u.test(line))).toBe(true);
		});

		it(`${image} puts stable runtime layers before compiled application code`, () => {
			const dockerfile = readFileSync(`${repoRoot}/deploy/images/Dockerfile.${image}`, "utf8");
			const dependencies = dockerfile.indexOf("COPY --from=build /app/node_modules");
			const manifests = dockerfile.indexOf("COPY --from=build --parents \\\n\t/app/./package.json");
			const application = dockerfile.indexOf(
				"COPY --from=build --parents \\\n\t/app/./packages/*/dist",
			);
			expect(dependencies).toBeGreaterThan(-1);
			expect(manifests).toBeGreaterThan(dependencies);
			expect(application).toBeGreaterThan(manifests);
			expect(dockerfile).not.toContain("COPY --from=build /app/packages ./packages");
		});
	}
});
