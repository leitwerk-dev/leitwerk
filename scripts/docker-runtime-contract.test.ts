import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptsDir = path.resolve("scripts/docker-runtime");
const scripts = ["test-local.sh", "test-docker-runner.sh", "test-kubernetes-runner.sh"];

describe("Docker runtime opt-in scripts", () => {
	it("keeps every opt-in script syntactically valid", () => {
		for (const name of scripts) execFileSync("bash", ["-n", path.join(scriptsDir, name)]);
	});

	it.each([0, 1])("cleans up only a namespace it created (create status %i)", (createStatus) => {
		const root = mkdtempSync(path.join(tmpdir(), "leitwerk-canary-ownership-"));
		const calls = path.join(root, "calls");
		try {
			writeFileSync(
				path.join(root, "kubectl"),
				`#!/bin/sh
printf '%s\\n' "$*" >> "$CANARY_TEST_CALLS"
if [ "$1" = create ]; then exit "$CANARY_TEST_CREATE_STATUS"; fi
if [ "$1" = delete ]; then exit 0; fi
exit 1
`,
				{ mode: 0o700 },
			);
			const result = spawnSync("/bin/bash", [path.join(scriptsDir, "test-kubernetes-runner.sh")], {
				env: {
					PATH: root,
					CANARY_TEST_CALLS: calls,
					CANARY_TEST_CREATE_STATUS: String(createStatus),
					LEITWERK_WORKER_IMAGE: "test-image",
					LEITWERK_RUNTIME_CLASS_NAME: "test-runtime",
					LEITWERK_DOCKER_STORAGE_CLASS_NAME: "test-storage",
					LEITWERK_DOCKER_TEST_NAMESPACE: "existing-operator-namespace",
				},
			});
			expect(result.status).not.toBe(0);
			const commands = readFileSync(calls, "utf8").trim().split("\n");
			expect(commands[0]).toBe("create namespace existing-operator-namespace");
			expect(commands.some((command) => command.startsWith("delete namespace "))).toBe(
				createStatus === 0,
			);
			if (createStatus !== 0) expect(commands).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
