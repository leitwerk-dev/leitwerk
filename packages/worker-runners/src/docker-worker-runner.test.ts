import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDockerWorkerRunner } from "./docker-worker-runner.js";
import { createFakeDockerEngineClient } from "./fake-docker-engine-client.js";
import type { StartWorkerInput, VolumeRef } from "./types.js";
import { buildWorkerUnitLabels } from "./worker-labels.js";

function startInput(
	overrides: Partial<StartWorkerInput> & Pick<StartWorkerInput, "instanceId" | "workerId">,
	volume: VolumeRef,
): StartWorkerInput {
	return {
		serverEpoch: "epoch-1",
		runnerKind: "isolated",
		image: { reference: "ghcr.io/example/worker:0.1.0" },
		env: { LEITWERK_SERVER_URL: "https://leitwerk-server:8080" },
		volume,
		isolation: { dind: false },
		...overrides,
	};
}

function bindRunner(hostRoot: string) {
	const engine = createFakeDockerEngineClient();
	const { runner, volume } = createDockerWorkerRunner({
		engine,
		volume: { mode: "bind", hostRoot, mountPath: "/state" },
		defaultNetwork: "leitwerk",
	});
	return { engine, runner, volume };
}

describe("Docker ProcessVolume (bind mode)", () => {
	it("creates a per-process host directory and is idempotent", async () => {
		const hostRoot = mkdtempSync(path.join(tmpdir(), "orch-docker-vol-"));
		try {
			const { volume } = bindRunner(hostRoot);
			const ref = await volume.ensure("proc-1");
			expect(ref.id).toBe(path.join(hostRoot, "proc-1"));
			expect(ref.mountPath).toBe("/state");
			expect(statSync(ref.id).isDirectory()).toBe(true);
			const again = await volume.ensure("proc-1");
			expect(again).toEqual(ref);
		} finally {
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("keeps the host directory on release (operator-managed retention)", async () => {
		const hostRoot = mkdtempSync(path.join(tmpdir(), "orch-docker-vol-"));
		try {
			const { engine, volume } = bindRunner(hostRoot);
			const ref = await volume.ensure("proc-1");
			await volume.release("proc-1");
			expect(engine.volumesRemoved).toEqual([]);
			expect(statSync(ref.id).isDirectory()).toBe(true);
		} finally {
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});
});

describe("Docker ProcessVolume (named_volume mode)", () => {
	it("ensures and removes a named volume", async () => {
		const engine = createFakeDockerEngineClient();
		const { volume } = createDockerWorkerRunner({
			engine,
			volume: { mode: "named_volume", hostRoot: "/unused", mountPath: "/state" },
			defaultNetwork: "leitwerk",
		});
		const ref = await volume.ensure("proc-1");
		expect(ref.id).toBe("leitwerk-process-proc-1");
		expect(engine.volumesEnsured).toEqual(["leitwerk-process-proc-1"]);
		await volume.release("proc-1");
		expect(engine.volumesRemoved).toEqual(["leitwerk-process-proc-1"]);
	});
});

describe("DockerWorkerRunner.start", () => {
	it("creates and starts a labelled container mounting the process volume", async () => {
		const hostRoot = mkdtempSync(path.join(tmpdir(), "orch-docker-"));
		try {
			const { engine, runner, volume } = bindRunner(hostRoot);
			const vol = await volume.ensure("proc-1");
			const unit = await runner.start(startInput({ instanceId: "proc-1", workerId: "wkr-1" }, vol));

			const record = engine.containers.get(unit.unitId);
			expect(record?.running).toBe(true);
			expect(record?.spec.image).toBe("ghcr.io/example/worker:0.1.0");
			expect(record?.spec.networkMode).toBe("leitwerk");
			expect(record?.spec.mounts).toEqual([{ source: vol.id, target: "/state" }]);
			expect(record?.spec.env).toContain("LEITWERK_SERVER_URL=https://leitwerk-server:8080");
			expect(record?.spec.labels["leitwerk.dev/instance-id"]).toBe("proc-1");
			expect(record?.spec.labels["leitwerk.dev/server-epoch"]).toBe("epoch-1");
			expect(record?.spec.privileged).toBe(false);
		} finally {
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("marks privileged and backs inner daemon storage when DinD isolation is requested", async () => {
		const hostRoot = mkdtempSync(path.join(tmpdir(), "orch-docker-"));
		try {
			const { engine, runner, volume } = bindRunner(hostRoot);
			const vol = await volume.ensure("proc-1");
			const unit = await runner.start(
				startInput(
					{ instanceId: "proc-1", workerId: "wkr-1", isolation: { dind: "privileged" } },
					vol,
				),
			);
			const record = engine.containers.get(unit.unitId);
			expect(record?.spec.privileged).toBe(true);
			// Inner dockerd storage is an anonymous Docker-managed volume, never the
			// process volume, so inner image/layer state stays out of /state.
			expect(record?.spec.anonymousVolumes).toEqual(["/var/lib/docker"]);
			expect(record?.spec.runtime).toBeUndefined();
		} finally {
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("applies the configured sysbox runtime without privileged for sysbox DinD", async () => {
		const hostRoot = mkdtempSync(path.join(tmpdir(), "orch-docker-"));
		try {
			const engine = createFakeDockerEngineClient();
			const { runner, volume } = createDockerWorkerRunner({
				engine,
				volume: { mode: "bind", hostRoot, mountPath: "/state" },
				defaultNetwork: "leitwerk",
				sysboxRuntime: "sysbox-runc",
			});
			const vol = await volume.ensure("proc-1");
			const unit = await runner.start(
				startInput({ instanceId: "proc-1", workerId: "wkr-1", isolation: { dind: "sysbox" } }, vol),
			);
			const record = engine.containers.get(unit.unitId);
			expect(record?.spec.privileged).toBe(false);
			expect(record?.spec.runtime).toBe("sysbox-runc");
			expect(record?.spec.anonymousVolumes).toEqual(["/var/lib/docker"]);
		} finally {
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("rejects sysbox DinD when no host sysbox runtime is configured", async () => {
		const hostRoot = mkdtempSync(path.join(tmpdir(), "orch-docker-"));
		try {
			const { runner, volume } = bindRunner(hostRoot);
			const vol = await volume.ensure("proc-1");
			await expect(
				runner.start(
					startInput(
						{ instanceId: "proc-1", workerId: "wkr-1", isolation: { dind: "sysbox" } },
						vol,
					),
				),
			).rejects.toThrow(/sysbox DinD requested but no host sysbox runtime/);
		} finally {
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("leaves a default worker without DinD storage or runtime overrides", async () => {
		const hostRoot = mkdtempSync(path.join(tmpdir(), "orch-docker-"));
		try {
			const { engine, runner, volume } = bindRunner(hostRoot);
			const vol = await volume.ensure("proc-1");
			const unit = await runner.start(startInput({ instanceId: "proc-1", workerId: "wkr-1" }, vol));
			const record = engine.containers.get(unit.unitId);
			expect(record?.spec.privileged).toBe(false);
			expect(record?.spec.anonymousVolumes).toBeUndefined();
			expect(record?.spec.runtime).toBeUndefined();
		} finally {
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("mounts configured server CA read-only and sets NODE_EXTRA_CA_CERTS", async () => {
		const hostRoot = mkdtempSync(path.join(tmpdir(), "orch-docker-"));
		try {
			const engine = createFakeDockerEngineClient();
			const { runner, volume } = createDockerWorkerRunner({
				engine,
				volume: { mode: "bind", hostRoot, mountPath: "/state" },
				defaultNetwork: "leitwerk",
				serverCaFile: "/etc/leitwerk/ca.pem",
			});
			const vol = await volume.ensure("proc-1");
			const unit = await runner.start(startInput({ instanceId: "proc-1", workerId: "wkr-1" }, vol));
			const record = engine.containers.get(unit.unitId);
			expect(record?.spec.mounts).toContainEqual({
				source: "/etc/leitwerk/ca.pem",
				target: "/leitwerk/server-ca.pem",
				readOnly: true,
			});
			expect(record?.spec.env).toContain("NODE_EXTRA_CA_CERTS=/leitwerk/server-ca.pem");
		} finally {
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("translates resource limits into nanoCpus and memory bytes", async () => {
		const hostRoot = mkdtempSync(path.join(tmpdir(), "orch-docker-"));
		try {
			const { engine, runner, volume } = bindRunner(hostRoot);
			const vol = await volume.ensure("proc-1");
			const unit = await runner.start(
				startInput(
					{ instanceId: "proc-1", workerId: "wkr-1", resources: { cpu: "2", memory: "2Gi" } },
					vol,
				),
			);
			const record = engine.containers.get(unit.unitId);
			expect(record?.spec.nanoCpus).toBe(2_000_000_000);
			expect(record?.spec.memoryBytes).toBe(2 * 1024 ** 3);
		} finally {
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});
});

describe("DockerWorkerRunner.stop", () => {
	it("stops then removes the ephemeral container with a grace timeout and keeps the volume", async () => {
		const hostRoot = mkdtempSync(path.join(tmpdir(), "orch-docker-"));
		try {
			const { engine, runner, volume } = bindRunner(hostRoot);
			const vol = await volume.ensure("proc-1");
			const unit = await runner.start(startInput({ instanceId: "proc-1", workerId: "wkr-1" }, vol));

			await runner.stop(unit, { graceMs: 5_000 });

			expect(engine.stopCalls).toEqual([{ id: unit.unitId, timeoutSeconds: 5 }]);
			expect(engine.removeCalls).toEqual([{ id: unit.unitId, force: true }]);
			expect(engine.containers.has(unit.unitId)).toBe(false);
			expect(engine.volumesRemoved).toEqual([]);
		} finally {
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});
});

describe("DockerWorkerRunner.list (adoption scan)", () => {
	it("returns descriptors for managed running containers", async () => {
		const hostRoot = mkdtempSync(path.join(tmpdir(), "orch-docker-"));
		try {
			const { engine, runner, volume } = bindRunner(hostRoot);
			const volA = await volume.ensure("proc-current");
			const current = await runner.start(
				startInput(
					{ instanceId: "proc-current", workerId: "wkr-current", serverEpoch: "epoch-2" },
					volA,
				),
			);
			const volB = await volume.ensure("proc-stale");
			await runner.start(
				startInput(
					{ instanceId: "proc-stale", workerId: "wkr-stale", serverEpoch: "epoch-1" },
					volB,
				),
			);

			const all = await runner.list();
			expect(all.map((d) => d.unitId)).toContain(current.unitId);
			expect(all).toHaveLength(2);
			expect(engine.containers.size).toBe(2);
		} finally {
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("ignores unmanaged containers discovered on the daemon", async () => {
		const hostRoot = mkdtempSync(path.join(tmpdir(), "orch-docker-"));
		try {
			const { engine, runner, volume } = bindRunner(hostRoot);
			const vol = await volume.ensure("proc-1");
			await runner.start(startInput({ instanceId: "proc-1", workerId: "wkr-1" }, vol));
			engine.seedContainer({
				id: "unrelated",
				labels: { "com.example/role": "db" },
				running: true,
			});

			const all = await runner.list();
			expect(all.every((d) => d.instanceId === "proc-1")).toBe(true);
		} finally {
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});
});

describe("DockerWorkerRunner.adopt", () => {
	it("reconnects to a running container discovered after a server restart", async () => {
		const engine = createFakeDockerEngineClient();
		const { runner } = createDockerWorkerRunner({
			engine,
			volume: { mode: "named_volume", hostRoot: "/unused", mountPath: "/state" },
			defaultNetwork: "leitwerk",
		});
		engine.seedContainer({
			id: "existing-1",
			labels: buildWorkerUnitLabels({
				instanceId: "proc-1",
				workerId: "wkr-1",
				serverEpoch: "epoch-1",
			}),
			running: true,
		});

		const [descriptor] = await runner.list();
		const adopted = await runner.adopt(descriptor);
		expect(adopted.unitId).toBe("existing-1");
		expect(adopted.instanceId).toBe("proc-1");
	});

	it("rejects adopting a container that is no longer running", async () => {
		const engine = createFakeDockerEngineClient();
		const { runner } = createDockerWorkerRunner({
			engine,
			volume: { mode: "named_volume", hostRoot: "/unused", mountPath: "/state" },
			defaultNetwork: "leitwerk",
		});
		engine.seedContainer({
			id: "existing-1",
			labels: buildWorkerUnitLabels({
				instanceId: "proc-1",
				workerId: "wkr-1",
				serverEpoch: "epoch-1",
			}),
			state: "exited",
		});

		await expect(
			runner.adopt({
				instanceId: "proc-1",
				workerId: "wkr-1",
				unitId: "existing-1",
			}),
		).rejects.toThrow(/not running/);
	});
});

describe("DockerWorkerRunner onExit", () => {
	it("maps a physical container exit into registered listeners", async () => {
		const hostRoot = mkdtempSync(path.join(tmpdir(), "orch-docker-"));
		try {
			const { engine, runner, volume } = bindRunner(hostRoot);
			const vol = await volume.ensure("proc-1");
			const unit = await runner.start(startInput({ instanceId: "proc-1", workerId: "wkr-1" }, vol));
			const onExit = vi.fn();
			unit.onExit(onExit);

			engine.simulateExit(unit.unitId, { statusCode: 137, oomKilled: true, signal: "SIGKILL" });
			await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));

			expect(onExit).toHaveBeenCalledWith({
				exitCode: 137,
				signal: "SIGKILL",
				oomKilled: true,
			});
		} finally {
			rmSync(hostRoot, { recursive: true, force: true });
		}
	});
});
