import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const { jobs } = parse(
	readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);

describe("required CI validation", () => {
	it("runs image and application validation independently behind the required result", () => {
		expect(jobs.validate.needs).toBeUndefined();
		expect(jobs["validate-images"].needs).toBeUndefined();
		expect(jobs["full-validation"].name).toBe("Full validation");
		expect(jobs["full-validation"].if).toBe(`\${{ always() }}`);
		expect(jobs["full-validation"].needs).toEqual(["validate", "validate-images"]);
	});

	const results = ["success", "failure", "cancelled", "skipped"];
	it.each(
		results.flatMap((application) => results.map((images) => [application, images])),
	)("gates application=%s, images=%s", (application, images) => {
		const step = jobs["full-validation"].steps[0];
		expect(step.env).toEqual({
			APPLICATION_RESULT: `\${{ needs.validate.result }}`,
			IMAGES_RESULT: `\${{ needs.validate-images.result }}`,
		});
		const result = spawnSync("bash", ["-e", "-c", step.run], {
			env: { ...process.env, APPLICATION_RESULT: application, IMAGES_RESULT: images },
		});
		expect(result.error).toBeUndefined();
		expect(result.status === 0).toBe(application === "success" && images === "success");
	});

	it("solves both full build targets without image export on one cache-backed builder", () => {
		const steps = jobs["validate-images"].steps;
		const builder = steps.find((step) => step.uses?.startsWith("docker/setup-buildx-action@"));
		expect(builder.with.driver).toBe("docker-container");
		const builds = steps.filter((step) => step.uses?.startsWith("docker/build-push-action@"));
		expect(builds.map((step) => step.with.file)).toEqual([
			"deploy/images/Dockerfile.server",
			"deploy/images/Dockerfile.worker-generic",
		]);
		const scopes = new Set();
		for (const { with: build } of builds) {
			expect(build.builder).toBe(`\${{ steps.${builder.id}.outputs.name }}`);
			expect(build.context).toBe(".");
			expect(build.target).toBe("build");
			expect(build.outputs).toBe("type=cacheonly");
			expect(build.load).toBeUndefined();
			expect(build.push).toBeUndefined();
			expect(build["cache-to"]).toContain("type=gha,mode=max,scope=");
			const scope = build["cache-to"].split("scope=")[1];
			scopes.add(scope);
			expect(build["cache-from"]).toContain(`type=gha,scope=${scope}`);
			expect(build["cache-from"]).toContain(
				`type=gha,scope=${scope.replace(`\${{ github.ref_name }}`, "main")}`,
			);
		}
		expect(scopes.size).toBe(2);
	});

	it("uploads detailed logs and suite/shard reports even when tests fail", () => {
		const steps = jobs.validate.steps;
		const gate = steps.find((step) => step.run === "npm run test:full");
		const upload = steps.find((step) => step.name === "Upload test reports and logs");
		expect(upload.if).toBe(`\${{ always() }}`);
		expect(upload.with.path).toContain(gate.env.LEITWERK_TEST_REPORTS_DIR);
		expect(upload.with.path).toContain(gate.env.LEITWERK_TEST_TIMINGS_FILE);
		expect(upload.with.path).toContain("test-results/");
	});
});
