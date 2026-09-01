import { describe, expect, it } from "vitest";
import {
	buildKubernetesAdmissionPolicyManifests,
	buildKubernetesDockerConfigJsonSecretManifest,
	buildKubernetesProcessNamespaceManifest,
	buildKubernetesProcessPvcManifest,
	buildKubernetesServerCaConfigMapManifest,
	buildKubernetesWorkerPodManifest,
	formatKubernetesPodDiagnostics,
	KUBERNETES_WORKER_SERVER_CA_CERT_PATH,
	KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_KEY,
	KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_NAME,
	KUBERNETES_WORKER_SERVER_CA_MOUNT_PATH,
	kubernetesProcessNamespaceName,
	kubernetesProcessPvcName,
	kubernetesWorkerPodName,
	mapKubernetesPodExit,
	sanitizeKubernetesNameSegment,
} from "./kubernetes-manifests.js";
import type { StartWorkerInput } from "./types.js";

function startInput(overrides: Partial<StartWorkerInput> = {}): StartWorkerInput {
	return {
		instanceId: "PROC_1",
		workerId: "WKR_1",
		serverEpoch: "epoch-1",
		runnerKind: "isolated",
		image: { reference: "ghcr.io/example/worker:1" },
		env: {
			LEITWERK_SERVER_URL: "http://server:8080",
			LEITWERK_INSTANCE_ID: "PROC_1",
			LEITWERK_WORKER_ID: "WKR_1",
			LEITWERK_WORKER_CONNECT_TOKEN: "secret-token",
		},
		volume: { instanceId: "PROC_1", id: "leitwerk-process-proc-1", mountPath: "/state" },
		docker: false,
		resources: { cpu: "2", memory: "4Gi" },
		...overrides,
	};
}

describe("Kubernetes manifest builders", () => {
	it("sanitizes and truncates resource names deterministically", () => {
		expect(sanitizeKubernetesNameSegment("My_Instance.01")).toBe("my-instance-01");
		expect(kubernetesWorkerPodName("Process_With_Uppercase", "Worker_With_Uppercase")).toMatch(
			/^leitwerk-worker-process-with-uppercase-worker-with-uppercas/,
		);
		expect(kubernetesWorkerPodName("a".repeat(80), "b".repeat(80)).length).toBeLessThanOrEqual(63);
		expect(kubernetesProcessPvcName("Process_1")).toBe("leitwerk-process-process-1");
		expect(kubernetesProcessNamespaceName("Process_1", "orch-proc-")).toBe("orch-proc-process-1");
	});

	it("builds a process namespace with durable process labels", () => {
		const manifest = buildKubernetesProcessNamespaceManifest({
			instanceId: "PROC_1",
			processNamespacePrefix: "leitwerk-process-",
		});

		expect(manifest.metadata.name).toBe("leitwerk-process-proc-1");
		expect(manifest.metadata.labels).toMatchObject({
			"leitwerk.dev/managed-by": "leitwerk",
			"leitwerk.dev/component": "process-namespace",
			"leitwerk.dev/instance-id": "PROC_1",
		});
		expect(manifest.metadata.labels["leitwerk.dev/worker-id"]).toBeUndefined();
		expect(manifest.metadata.labels["leitwerk.dev/server-epoch"]).toBeUndefined();
	});

	it("builds a PVC with retained process identity labels and storage settings", () => {
		const manifest = buildKubernetesProcessPvcManifest({
			instanceId: "PROC_1",
			namespace: "leitwerk",
			volume: {
				storageClassName: "standard",
				size: "20Gi",
				accessModes: ["ReadWriteOnce"],
				mountPath: "/state",
			},
		});

		expect(manifest.metadata.name).toBe("leitwerk-process-proc-1");
		expect(manifest.metadata.namespace).toBe("leitwerk");
		expect(manifest.metadata.labels).toMatchObject({
			"leitwerk.dev/managed-by": "leitwerk",
			"leitwerk.dev/component": "process-volume",
			"leitwerk.dev/instance-id": "PROC_1",
		});
		expect(manifest.metadata.labels["leitwerk.dev/worker-id"]).toBeUndefined();
		expect(manifest.metadata.labels["leitwerk.dev/server-epoch"]).toBeUndefined();
		expect(manifest.spec).toEqual({
			accessModes: ["ReadWriteOnce"],
			resources: { requests: { storage: "20Gi" } },
			storageClassName: "standard",
		});
	});

	it("builds a per-process server CA ConfigMap", () => {
		const manifest = buildKubernetesServerCaConfigMapManifest({
			instanceId: "PROC_1",
			namespace: "leitwerk-process-proc-1",
			caPem: "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
		});

		expect(manifest.metadata.name).toBe(KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_NAME);
		expect(manifest.metadata.labels).toMatchObject({
			"leitwerk.dev/managed-by": "leitwerk",
			"leitwerk.dev/component": "server-ca",
			"leitwerk.dev/instance-id": "PROC_1",
		});
		expect(manifest.data[KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_KEY]).toContain(
			"BEGIN CERTIFICATE",
		);
	});

	it("builds a managed dockerconfigjson Secret containing no extra keys", () => {
		const manifest = buildKubernetesDockerConfigJsonSecretManifest({
			instanceId: "PROC_1",
			namespace: "leitwerk-process-proc-1",
			name: "private-registry",
			dockerConfigJson: "encoded-config",
		});

		expect(manifest).toMatchObject({
			metadata: {
				name: "private-registry",
				labels: {
					"leitwerk.dev/managed-by": "leitwerk",
					"leitwerk.dev/component": "image-pull-secret",
					"leitwerk.dev/instance-id": "PROC_1",
				},
			},
			type: "kubernetes.io/dockerconfigjson",
			data: { ".dockerconfigjson": "encoded-config" },
		});
		expect(Object.keys(manifest.data)).toEqual([".dockerconfigjson"]);
	});

	it("builds a worker pod with env, volume mount, resources, pull secrets, aliases, and service account", () => {
		const hostAliases = [
			{ ip: "192.0.2.10", hostnames: ["model-api.example.test", "models.example.test"] },
			{ ip: "2001:db8::10", hostnames: ["model-api-v6.example.test"] },
		];
		const manifest = buildKubernetesWorkerPodManifest(startInput(), {
			namespace: "leitwerk",
			workerServiceAccount: "leitwerk-worker",
			imagePullSecrets: ["ghcr"],
			imagePullPolicy: "IfNotPresent",
			nodeSelector: { lane: "workers" },
			annotations: { "example.com/trace": "enabled" },
			tolerations: [{ key: "dedicated", operator: "Exists" }],
			hostAliases,
		});

		expect(manifest.metadata.name).toBe("leitwerk-worker-proc-1-wkr-1");
		expect(manifest.metadata.labels).toMatchObject({
			"leitwerk.dev/managed-by": "leitwerk",
			"leitwerk.dev/component": "worker",
			"leitwerk.dev/instance-id": "PROC_1",
			"leitwerk.dev/worker-id": "WKR_1",
			"leitwerk.dev/server-epoch": "epoch-1",
		});
		expect(manifest.metadata.annotations).toEqual({ "example.com/trace": "enabled" });
		expect(manifest.spec.restartPolicy).toBe("Never");
		expect(manifest.spec.serviceAccountName).toBe("leitwerk-worker");
		expect(manifest.spec.imagePullSecrets).toEqual([{ name: "ghcr" }]);
		expect(manifest.spec.nodeSelector).toEqual({ lane: "workers" });
		expect(manifest.spec.tolerations).toEqual([{ key: "dedicated", operator: "Exists" }]);
		expect(manifest.spec.hostAliases).toEqual(hostAliases);
		hostAliases[0]?.hostnames.push("mutated.example.test");
		expect(manifest.spec.hostAliases?.[0]?.hostnames).toEqual([
			"model-api.example.test",
			"models.example.test",
		]);
		expect(manifest.spec.volumes).toEqual([
			{
				name: "process-state",
				persistentVolumeClaim: { claimName: "leitwerk-process-proc-1" },
			},
		]);
		const container = manifest.spec.containers[0];
		expect(container.image).toBe("ghcr.io/example/worker:1");
		expect(container.imagePullPolicy).toBe("IfNotPresent");
		expect(container.volumeMounts).toEqual([{ name: "process-state", mountPath: "/state" }]);
		expect(container.resources).toEqual({ limits: { cpu: "2", memory: "4Gi" } });
		expect(container.env).toContainEqual({
			name: "LEITWERK_WORKER_CONNECT_TOKEN",
			value: "secret-token",
		});
	});

	it("omits host aliases from worker Pods when none are configured", () => {
		const manifest = buildKubernetesWorkerPodManifest(startInput(), { namespace: "leitwerk" });

		expect(manifest.spec).not.toHaveProperty("hostAliases");
	});

	it("mounts a server CA ConfigMap into worker pods when configured", () => {
		const manifest = buildKubernetesWorkerPodManifest(startInput(), {
			namespace: "leitwerk",
			serverCaConfigMap: {
				name: KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_NAME,
				key: KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_KEY,
				mountPath: KUBERNETES_WORKER_SERVER_CA_MOUNT_PATH,
			},
		});

		const container = manifest.spec.containers[0];
		expect(container.env).toContainEqual({
			name: "NODE_EXTRA_CA_CERTS",
			value: KUBERNETES_WORKER_SERVER_CA_CERT_PATH,
		});
		expect(container.volumeMounts).toContainEqual({
			name: "server-ca",
			mountPath: KUBERNETES_WORKER_SERVER_CA_MOUNT_PATH,
			readOnly: true,
		});
		expect(manifest.spec.volumes).toContainEqual({
			name: "server-ca",
			configMap: {
				name: KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_NAME,
				items: [
					{
						key: KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_KEY,
						path: KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_KEY,
					},
				],
			},
		});
	});

	it("builds admission policy constraints for process resources", () => {
		const { policy, binding } = buildKubernetesAdmissionPolicyManifests({
			name: "leitwerk-process-policy",
			serverNamespace: "leitwerk-system",
			serverServiceAccountName: "leitwerk-server",
			processNamespacePrefix: "leitwerk-process-",
			allowedWorkerServiceAccount: "leitwerk-worker",
			allowedImagePullSecretNames: ["private-registry"],
		});
		const expressions = policy.spec.validations.map((validation) => validation.expression);

		expect(policy.spec.matchConditions?.[0]?.expression).toContain(
			"system:serviceaccount:leitwerk-system:leitwerk-server",
		);
		expect(policy.spec.matchConstraints.resourceRules[0]?.resources).toEqual([
			"namespaces",
			"pods",
			"persistentvolumeclaims",
			"serviceaccounts",
			"configmaps",
			"secrets",
		]);
		expect(expressions).toEqual(
			expect.arrayContaining([
				expect.stringContaining("leitwerk-process-"),
				expect.stringContaining("process-namespace"),
				expect.stringContaining("process-volume"),
				expect.stringContaining("server-ca"),
				expect.stringContaining("private-registry"),
				expect.stringContaining("image-pull-secret"),
				expect.stringContaining(".dockerconfigjson"),
				expect.stringContaining("worker-service-account"),
				expect.stringContaining("leitwerk-worker"),
				expect.stringContaining("leitwerk.dev/worker-id"),
				expect.stringContaining("leitwerk.dev/server-epoch"),
				expect.stringContaining("session-export-helper"),
				expect.stringContaining("leitwerk.dev/export-id"),
			]),
		);
		expect(binding.spec).toEqual({
			policyName: "leitwerk-process-policy",
			validationActions: ["Deny"],
		});
	});

	it("maps Kubernetes failure observations into worker exits", () => {
		expect(mapKubernetesPodExit({ phase: "Failed", reason: "Evicted", exitCode: 137 })).toEqual({
			exitCode: 137,
			signal: null,
			reason: "Evicted",
		});
	});

	it("includes a bounded container startup termination diagnostic", () => {
		const exit = mapKubernetesPodExit({
			phase: "Failed",
			reason: "Error",
			exitCode: 1,
			terminationMessage: `dockerd failed: ${"x".repeat(10_000)}`,
		});

		expect(exit.reason).toContain("Runtime startup: dockerd failed");
		expect(exit.reason?.length).toBeLessThanOrEqual(2_048);
	});

	it("bounds individual Kubernetes diagnostic messages", () => {
		const diagnostics = formatKubernetesPodDiagnostics([
			{ type: "Warning", reason: "FailedCreatePodSandBox", message: "x".repeat(10_000) },
		]);

		expect(diagnostics?.length).toBeLessThanOrEqual(2_048);
		expect(diagnostics).toContain("FailedCreatePodSandBox");
	});

	it("adds bounded Kubernetes event diagnostics to failure reasons", () => {
		expect(
			mapKubernetesPodExit({
				phase: "Failed",
				reason: "Unschedulable",
				events: [
					{ type: "Warning", reason: "FailedScheduling", count: 4, message: "0/3 nodes fit" },
					{ type: "Normal", reason: "NotTriggerScaleUp", message: "pod did not trigger scale-up" },
					{ type: "Warning", reason: "FailedMount", message: "PVC not attached" },
					{ type: "Warning", reason: "Extra", message: "not included" },
				],
			}),
		).toEqual({
			exitCode: null,
			signal: null,
			reason:
				"Unschedulable; Kubernetes events: Warning FailedScheduling x4: 0/3 nodes fit | Normal NotTriggerScaleUp: pod did not trigger scale-up | Warning FailedMount: PVC not attached",
		});
	});
});
