import type { ExtensionProcessDefinition } from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import { assertProcessRuntimeAvailable } from "./process-runtime-availability.js";

function processes(docker: boolean) {
	return new Map([
		[
			"process",
			{
				id: "process",
				runtime: docker ? { docker: true } : undefined,
			} as ExtensionProcessDefinition,
		],
	]);
}

describe("process runtime availability", () => {
	it("does not preflight ordinary processes", async () => {
		const config = getDefaultConfig();
		config.workers.runner = "local";
		const dockerInfo = vi.fn();
		await assertProcessRuntimeAvailable(
			{ config, processes: processes(false), dockerInfo },
			"process",
		);
		expect(dockerInfo).not.toHaveBeenCalled();
	});

	it("requires local host acknowledgement before docker info", async () => {
		const config = getDefaultConfig();
		config.workers.runner = "local";
		const dockerInfo = vi.fn();
		await expect(
			assertProcessRuntimeAvailable({ config, processes: processes(true), dockerInfo }, "process"),
		).rejects.toThrow(/allow_host_docker/);
		expect(dockerInfo).not.toHaveBeenCalled();
	});

	it("runs docker info for acknowledged local Docker processes", async () => {
		const config = getDefaultConfig();
		config.workers.runner = "local";
		config.workers.startup_timeout = "750ms";
		if (config.local_worker) config.local_worker.allow_host_docker = true;
		const dockerInfo = vi.fn().mockResolvedValue(undefined);
		await assertProcessRuntimeAvailable(
			{ config, processes: processes(true), dockerInfo },
			"process",
		);
		expect(dockerInfo).toHaveBeenCalledOnce();
		expect(dockerInfo).toHaveBeenCalledWith(750);
	});

	it("requires Docker runner private daemon configuration", async () => {
		const config = getDefaultConfig();
		await expect(
			assertProcessRuntimeAvailable({ config, processes: processes(true) }, "process"),
		).rejects.toThrow(/private_daemon/);
		if (config.docker) config.docker.private_daemon = { isolation: "privileged" };
		await expect(
			assertProcessRuntimeAvailable({ config, processes: processes(true) }, "process"),
		).resolves.toBeUndefined();
	});

	it("makes only Docker processes unavailable for incomplete Kubernetes Docker wiring", async () => {
		const config = getDefaultConfig();
		config.workers.runner = "kubernetes";
		if (config.kubernetes) {
			config.kubernetes.docker = { runtime_class_name: "leitwerk-sysbox" };
		}

		await expect(
			assertProcessRuntimeAvailable({ config, processes: processes(false) }, "process"),
		).resolves.toBeUndefined();
		await expect(
			assertProcessRuntimeAvailable({ config, processes: processes(true) }, "process"),
		).rejects.toThrow(/kubernetes\.docker/);
	});

	it("accepts complete Kubernetes Docker wiring without cluster preflight", async () => {
		const config = getDefaultConfig();
		config.workers.runner = "kubernetes";
		if (config.kubernetes) {
			config.kubernetes.docker = {
				runtime_class_name: "leitwerk-sysbox",
				host_users: false,
				process_storage_class_name: "leitwerk-docker-process",
			};
		}

		await expect(
			assertProcessRuntimeAvailable({ config, processes: processes(true) }, "process"),
		).resolves.toBeUndefined();
	});
});
