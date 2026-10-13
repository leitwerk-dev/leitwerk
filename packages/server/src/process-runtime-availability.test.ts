import type { ExtensionProcessDefinition } from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import {
	assertProcessRuntimeAvailable,
	resolveKubernetesDockerConfig,
} from "./process-runtime-availability.js";

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
		expect(config.local_worker).toBeDefined();
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
		expect(config.docker).toBeDefined();
		if (config.docker) config.docker.private_daemon = { isolation: "privileged" };
		await expect(
			assertProcessRuntimeAvailable({ config, processes: processes(true) }, "process"),
		).resolves.toBeUndefined();
	});

	it("makes only Docker processes unavailable for incomplete Kubernetes Docker wiring", async () => {
		const config = getDefaultConfig();
		config.workers.runner = "kubernetes";
		expect(config.kubernetes).toBeDefined();
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

	it.each([
		{ selection: { gvisor: true }, isolation: "gvisor" },
		{ selection: { isolation: "gvisor" as const }, isolation: "gvisor" },
		{ selection: { isolation: "virtual-machine" as const }, isolation: "virtual-machine" },
	])("normalizes $selection and requires omitted hostUsers", async ({ selection, isolation }) => {
		const config = getDefaultConfig();
		config.workers.runner = "kubernetes";
		if (!config.kubernetes) throw new Error("Missing default Kubernetes config");
		config.kubernetes.docker = {
			runtime_class_name: "qualified-sandbox",
			...selection,
			process_storage_class_name: "longhorn",
		};
		expect(resolveKubernetesDockerConfig(config)).toEqual({
			runtimeClassName: "qualified-sandbox",
			isolation,
			processStorageClassName: "longhorn",
		});
		await expect(
			assertProcessRuntimeAvailable({ config, processes: processes(true) }, "process"),
		).resolves.toBeUndefined();
		for (const hostUsers of [false, true]) {
			config.kubernetes.docker.host_users = hostUsers;
			expect(resolveKubernetesDockerConfig(config)).toBeUndefined();
			await expect(
				assertProcessRuntimeAvailable({ config, processes: processes(true) }, "process"),
			).rejects.toThrow(/kubernetes.docker/);
		}
	});

	it.each([
		false,
		true,
	])("preserves explicit host_users=%s without cluster preflight", async (hostUsers) => {
		const config = getDefaultConfig();
		config.workers.runner = "kubernetes";
		expect(config.kubernetes).toBeDefined();
		if (config.kubernetes) {
			config.kubernetes.docker = {
				runtime_class_name: "leitwerk-sysbox",
				host_users: hostUsers,
				gvisor: false,
				process_storage_class_name: "leitwerk-docker-process",
			};
		}
		expect(resolveKubernetesDockerConfig(config)).toEqual({
			runtimeClassName: "leitwerk-sysbox",
			hostUsers,
			processStorageClassName: "leitwerk-docker-process",
		});

		await expect(
			assertProcessRuntimeAvailable({ config, processes: processes(true) }, "process"),
		).resolves.toBeUndefined();
	});

	it("rejects conflicting sandbox selection at the process availability boundary", async () => {
		const config = getDefaultConfig();
		config.workers.runner = "kubernetes";
		if (!config.kubernetes) throw new Error("Missing default Kubernetes config");
		config.kubernetes.docker = {
			runtime_class_name: "qualified-sandbox",
			process_storage_class_name: "longhorn",
			isolation: "virtual-machine",
			gvisor: true,
		};
		expect(resolveKubernetesDockerConfig(config)).toBeUndefined();
		await expect(
			assertProcessRuntimeAvailable({ config, processes: processes(true) }, "process"),
		).rejects.toThrow(/kubernetes.docker/);
	});
});
