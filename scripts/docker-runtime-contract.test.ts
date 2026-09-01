import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "vitest";

const scriptsDir = path.resolve("scripts/docker-runtime");
const scripts = ["test-local.sh", "test-docker-runner.sh", "test-kubernetes-runner.sh"];

describe("Docker runtime opt-in scripts", () => {
	it("keeps every opt-in script syntactically valid", () => {
		execFileSync("bash", ["-n", ...scripts.map((name) => path.join(scriptsDir, name))]);
	});
});
