import type { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalWorkerRunner } from "./local-worker-runner.js";
import type { LocalStartWorkerInput } from "./types.js";

function startInput(env: Record<string, string>): LocalStartWorkerInput {
	return {
		runnerKind: "local",
		instanceId: "process",
		workerId: "worker",
		serverEpoch: "epoch",
		image: { reference: "unused:local" },
		docker: true,
		env,
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("local Docker preflight", () => {
	it("kills an unresponsive Docker probe and never starts the worker", async () => {
		const directory = await mkdtemp(join(tmpdir(), "leitwerk-docker-preflight-"));
		try {
			await writeFile(
				join(directory, "docker"),
				`#!${process.execPath}\nif (process.env.DOCKER_CONTEXT !== "operator-context") process.exit(7);\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`,
				{ mode: 0o755 },
			);
			vi.stubEnv("PATH", directory);
			vi.stubEnv("DOCKER_CONTEXT", "operator-context");
			const localWorkerSpawnImpl = vi.fn<typeof spawn>();
			const { runner } = createLocalWorkerRunner({
				args: ["unused-worker-entry"],
				allowHostDocker: true,
				localWorkerSpawnImpl,
			});
			await expect(
				runner.start(startInput({ LEITWERK_WORKER_STARTUP_TIMEOUT_MS: "200" })),
			).rejects.toMatchObject({
				cause: {
					message: "Docker preflight timed out after 200ms",
					cause: { killed: true, signal: "SIGKILL" },
				},
			});
			expect(localWorkerSpawnImpl).not.toHaveBeenCalled();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("caps the Docker check at the remaining worker startup deadline", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		const dockerPreflightImpl = vi.fn().mockRejectedValue(new Error("probe timed out"));
		const localWorkerSpawnImpl = vi.fn<typeof spawn>();
		const { runner } = createLocalWorkerRunner({
			args: ["unused-worker-entry"],
			allowHostDocker: true,
			dockerPreflightImpl,
			localWorkerSpawnImpl,
		});
		await expect(
			runner.start(
				startInput({
					LEITWERK_WORKER_STARTUP_TIMEOUT_MS: "750",
					LEITWERK_WORKER_STARTUP_DEADLINE_MS: "1200",
				}),
			),
		).rejects.toThrow("Local Docker preflight failed");
		expect(dockerPreflightImpl).toHaveBeenCalledWith(200);
		expect(localWorkerSpawnImpl).not.toHaveBeenCalled();
	});

	it("rejects an expired startup before probing Docker or spawning a worker", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		const dockerPreflightImpl = vi.fn();
		const localWorkerSpawnImpl = vi.fn<typeof spawn>();
		const { runner } = createLocalWorkerRunner({
			args: ["unused-worker-entry"],
			allowHostDocker: true,
			dockerPreflightImpl,
			localWorkerSpawnImpl,
		});
		await expect(
			runner.start(startInput({ LEITWERK_WORKER_STARTUP_DEADLINE_MS: "1000" })),
		).rejects.toMatchObject({
			cause: { message: "Worker startup deadline expired before Docker preflight" },
		});
		expect(dockerPreflightImpl).not.toHaveBeenCalled();
		expect(localWorkerSpawnImpl).not.toHaveBeenCalled();
	});
});
