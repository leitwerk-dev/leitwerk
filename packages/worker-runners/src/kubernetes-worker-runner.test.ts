import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeKubernetesApiClient } from "./kubernetes-api-client.js";
import {
	buildKubernetesDockerConfigJsonSecretManifest,
	KUBERNETES_WORKER_SERVER_CA_CERT_PATH,
	KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_NAME,
	kubernetesProcessNamespaceName,
	kubernetesProcessPvcName,
	kubernetesWorkerPodName,
} from "./kubernetes-manifests.js";
import { createKubernetesWorkerRunner } from "./kubernetes-worker-runner.js";
import type { StartWorkerInput, VolumeRef } from "./types.js";

function bindRunner() {
	const client = new FakeKubernetesApiClient();
	const { runner, volume } = createKubernetesWorkerRunner({
		client,
		processNamespacePrefix: "leitwerk-test-process-",
		volume: { size: "5Gi", accessModes: ["ReadWriteOnce"], mountPath: "/state" },
		pod: { workerServiceAccount: "leitwerk-worker", imagePullSecrets: ["registry"] },
	});
	return { client, runner, volume };
}

function startInput(overrides: Partial<StartWorkerInput>, volume: VolumeRef): StartWorkerInput {
	return {
		instanceId: "proc-1",
		workerId: "wkr-1",
		serverEpoch: "epoch-1",
		runnerKind: "isolated",
		image: { reference: "ghcr.io/example/worker:1" },
		env: { LEITWERK_SERVER_URL: "http://server:8080" },
		volume,
		isolation: { dind: false },
		...overrides,
	};
}

describe("Kubernetes ProcessVolume", () => {
	it("copies only dockerconfigjson registry data before provisioning a worker volume", async () => {
		const client = new FakeKubernetesApiClient();
		await client.ensureDockerConfigJsonSecret(
			buildKubernetesDockerConfigJsonSecretManifest({
				instanceId: "source",
				namespace: "leitwerk-system",
				name: "registry-source",
				dockerConfigJson: "base64-docker-config",
			}),
		);
		const { volume } = createKubernetesWorkerRunner({
			client,
			processNamespacePrefix: "leitwerk-test-process-",
			serverNamespace: "leitwerk-system",
			imagePullSecretCopies: [{ sourceName: "registry-source", targetName: "registry-target" }],
			volume: { size: "5Gi", accessModes: ["ReadWriteOnce"], mountPath: "/state" },
		});

		await volume.ensure("proc-1");

		expect(client.secrets.get("leitwerk-test-process-proc-1/registry-target")).toEqual({
			apiVersion: "v1",
			kind: "Secret",
			metadata: {
				name: "registry-target",
				namespace: "leitwerk-test-process-proc-1",
				labels: {
					"leitwerk.dev/managed-by": "leitwerk",
					"leitwerk.dev/component": "image-pull-secret",
					"leitwerk.dev/instance-id": "proc-1",
				},
			},
			type: "kubernetes.io/dockerconfigjson",
			data: { ".dockerconfigjson": "base64-docker-config" },
		});
	});

	it("retention releases only the process PVC", async () => {
		const { client, volume } = bindRunner();

		const ref = await volume.ensure("proc-1");

		expect(ref).toEqual({
			instanceId: "proc-1",
			id: "leitwerk-process-proc-1",
			mountPath: "/state",
			namespace: "leitwerk-test-process-proc-1",
		});
		expect(client.namespaces.has("leitwerk-test-process-proc-1")).toBe(true);
		expect(client.pvcs.has("leitwerk-test-process-proc-1/leitwerk-process-proc-1")).toBe(true);

		await volume.release("proc-1");
		expect(client.deletedPvcs).toEqual([
			{ namespace: "leitwerk-test-process-proc-1", name: "leitwerk-process-proc-1" },
		]);
		expect(client.namespaces.has("leitwerk-test-process-proc-1")).toBe(true);
	});

	it("permanent deletion idempotently removes the process namespace and its resources", async () => {
		const { client, volume } = bindRunner();
		await volume.ensure("proc-1");

		await volume.deleteProcessResources("proc-1");
		await volume.deleteProcessResources("proc-1");

		expect(client.deletedNamespaces).toEqual([
			"leitwerk-test-process-proc-1",
			"leitwerk-test-process-proc-1",
		]);
		expect(client.namespaces.has("leitwerk-test-process-proc-1")).toBe(false);
		expect(client.pvcs.has("leitwerk-test-process-proc-1/leitwerk-process-proc-1")).toBe(false);
	});
});

describe("KubernetesWorkerRunner", () => {
	it("start creates a pod after PVC ensure and wires Kubernetes metadata", async () => {
		const { client, runner, volume } = bindRunner();
		const vol = await volume.ensure("proc-1");

		const unit = await runner.start(startInput({ instanceId: "proc-1", workerId: "wkr-1" }, vol));

		expect(unit).toMatchObject({
			instanceId: "proc-1",
			workerId: "wkr-1",
			unitId: "leitwerk-worker-proc-1-wkr-1",
		});
		const pod = client.pods.get("leitwerk-test-process-proc-1/leitwerk-worker-proc-1-wkr-1");
		expect(pod?.spec.serviceAccountName).toBe("leitwerk-worker");
		expect(pod?.spec.volumes[0]).toEqual({
			name: "process-state",
			persistentVolumeClaim: { claimName: "leitwerk-process-proc-1" },
		});
		expect(pod?.metadata.labels["leitwerk.dev/server-epoch"]).toBe("epoch-1");
	});

	it("copies configured server CA into the process namespace and mounts it into workers", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "orch-k8s-ca-"));
		try {
			const caFile = path.join(dir, "ca.pem");
			writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n");
			const client = new FakeKubernetesApiClient();
			const { runner, volume } = createKubernetesWorkerRunner({
				client,
				processNamespacePrefix: "leitwerk-test-process-",
				volume: { size: "5Gi", accessModes: ["ReadWriteOnce"], mountPath: "/state" },
				serverCaFile: caFile,
			});
			const vol = await volume.ensure("proc-1");
			await runner.start(startInput({ instanceId: "proc-1", workerId: "wkr-1" }, vol));

			const configMap = client.configMaps.get("leitwerk-test-process-proc-1/leitwerk-server-ca");
			expect(configMap?.data["server-ca.pem"]).toContain("BEGIN CERTIFICATE");
			const pod = client.pods.get("leitwerk-test-process-proc-1/leitwerk-worker-proc-1-wkr-1");
			expect(pod?.spec.containers[0]?.env).toContainEqual({
				name: "NODE_EXTRA_CA_CERTS",
				value: KUBERNETES_WORKER_SERVER_CA_CERT_PATH,
			});
			expect(pod?.spec.volumes).toContainEqual({
				name: "server-ca",
				configMap: {
					name: KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_NAME,
					items: [{ key: "server-ca.pem", path: "server-ca.pem" }],
				},
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stop deletes the worker pod and keeps the process PVC", async () => {
		const { client, runner, volume } = bindRunner();
		const vol = await volume.ensure("proc-1");
		const unit = await runner.start(startInput({}, vol));

		await runner.stop(unit, { graceMs: 1500 });

		expect(client.deletedPods).toEqual([
			{
				namespace: "leitwerk-test-process-proc-1",
				name: "leitwerk-worker-proc-1-wkr-1",
				gracePeriodSeconds: 2,
			},
		]);
		expect(client.pvcs.has("leitwerk-test-process-proc-1/leitwerk-process-proc-1")).toBe(true);
	});

	it("lists labelled pods for adoption scans", async () => {
		const { runner, volume } = bindRunner();
		const firstVolume = await volume.ensure("proc-1");
		const secondVolume = await volume.ensure("proc-2");
		await runner.start(
			startInput({ instanceId: "proc-1", workerId: "wkr-1", serverEpoch: "epoch-1" }, firstVolume),
		);
		await runner.start(
			startInput({ instanceId: "proc-2", workerId: "wkr-2", serverEpoch: "epoch-2" }, secondVolume),
		);

		expect(await runner.list()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					instanceId: "proc-1",
					workerId: "wkr-1",
				}),
				expect.objectContaining({
					instanceId: "proc-2",
					workerId: "wkr-2",
				}),
			]),
		);
	});

	it("adopt reconnects to running pods and rejects failed pods", async () => {
		const { client, runner, volume } = bindRunner();
		const vol = await volume.ensure("proc-1");
		await runner.start(startInput({}, vol));
		const [descriptor] = await runner.list();

		await expect(runner.adopt(descriptor)).resolves.toMatchObject({ unitId: descriptor.unitId });

		client.simulatePodFailure(descriptor.unitId, "leitwerk-test-process-proc-1", {
			exitCode: 1,
			signal: null,
			reason: "Error",
		});
		await expect(runner.adopt(descriptor)).rejects.toThrow(/not running/);
	});

	it("maps pod failures through WorkerUnit.onExit", async () => {
		const { client, runner, volume } = bindRunner();
		const vol = await volume.ensure("proc-1");
		const unit = await runner.start(startInput({}, vol));
		const exit = new Promise((resolve) => unit.onExit(resolve));

		client.simulatePodFailure(unit.unitId, "leitwerk-test-process-proc-1", {
			exitCode: 137,
			signal: null,
			oomKilled: true,
			reason: "Evicted",
		});

		await expect(exit).resolves.toEqual({
			exitCode: 137,
			signal: null,
			oomKilled: true,
			reason: "Evicted",
		});
	});

	it("includes recorded Kubernetes events in fake-client failure diagnostics", async () => {
		const { client, runner, volume } = bindRunner();
		const vol = await volume.ensure("proc-1");
		const unit = await runner.start(startInput({}, vol));
		const exit = new Promise((resolve) => unit.onExit(resolve));
		client.recordPodEvent(unit.unitId, "leitwerk-test-process-proc-1", {
			type: "Warning",
			reason: "FailedScheduling",
			message: "0/2 nodes are available",
			count: 2,
		});

		client.simulatePodFailure(unit.unitId, "leitwerk-test-process-proc-1", {
			exitCode: null,
			signal: null,
			reason: "Unschedulable",
		});

		await expect(exit).resolves.toEqual({
			exitCode: null,
			signal: null,
			reason:
				"Unschedulable; Kubernetes events: Warning FailedScheduling x2: 0/2 nodes are available",
		});
	});

	it("rejects DinD profiles before pod creation", async () => {
		const { client, runner, volume } = bindRunner();
		const vol = await volume.ensure("proc-1");

		await expect(
			runner.start(startInput({ isolation: { dind: "privileged" } }, vol)),
		).rejects.toThrow(/Docker-in-Docker/);
		expect(client.pods.size).toBe(0);
	});

	it("uses deterministic Kubernetes names", () => {
		expect(kubernetesWorkerPodName("proc-1", "wkr-1")).toBe("leitwerk-worker-proc-1-wkr-1");
		expect(kubernetesProcessPvcName("proc-1")).toBe("leitwerk-process-proc-1");
		expect(kubernetesProcessNamespaceName("proc-1", "leitwerk-test-process-")).toBe(
			"leitwerk-test-process-proc-1",
		);
	});
});
