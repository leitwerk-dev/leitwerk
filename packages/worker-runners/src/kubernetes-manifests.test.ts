import { describe, expect, it } from "vitest";
import {
	buildKubernetesDockerConfigJsonSecretManifest,
	buildKubernetesExportHelperPodManifest,
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
		resourceRequests: { cpu: "1", memory: "2Gi" },
		...overrides,
	};
}

describe("Kubernetes manifest builders", () => {
	it("overrides selector keys only for Docker workers and preserves common constraints", () => {
		const options = {
			namespace: "process",
			nodeSelector: { hostname: "ordinary", os: "linux" },
			docker: {
				runtimeClassName: "qualified-vm",
				isolation: "virtual-machine" as const,
				nodeSelector: { hostname: "vm", qualified: "yes" },
			},
		};
		const original = structuredClone(options);
		const ordinary = buildKubernetesWorkerPodManifest(startInput(), options);
		const docker = buildKubernetesWorkerPodManifest(startInput({ docker: true }), options);
		expect(ordinary.spec.nodeSelector).toEqual({ hostname: "ordinary", os: "linux" });
		expect(ordinary.spec.runtimeClassName).toBeUndefined();
		expect(docker.spec.nodeSelector).toEqual({ hostname: "vm", os: "linux", qualified: "yes" });
		expect(docker.spec.runtimeClassName).toBe("qualified-vm");
		expect(options).toEqual(original);
		options.docker.nodeSelector = {} as typeof options.docker.nodeSelector;
		expect(
			buildKubernetesWorkerPodManifest(startInput({ docker: true }), options).spec.nodeSelector,
		).toEqual(ordinary.spec.nodeSelector);
	});

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
		expect(manifest.data[KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_KEY]).toBe(
			"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
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
		expect(manifest.spec).not.toHaveProperty("automountServiceAccountToken");
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
		expect(container.resources).toEqual({
			limits: { cpu: "2", memory: "4Gi" },
			requests: { cpu: "1", memory: "2Gi" },
		});
		expect(container.env).toContainEqual({
			name: "LEITWERK_WORKER_CONNECT_TOKEN",
			value: "secret-token",
		});
	});

	it("keeps private Docker state on the configured PVC mount despite caller environment", () => {
		const manifest = buildKubernetesWorkerPodManifest(
			startInput({
				docker: true,
				volume: {
					instanceId: "PROC_1",
					id: "leitwerk-process-proc-1",
					mountPath: "/process-storage",
				},
				env: { LEITWERK_PROCESS_VOLUME_MOUNT_PATH: "/unmounted" },
			}),
			{ namespace: "leitwerk", docker: { runtimeClassName: "sysbox", hostUsers: false } },
		);
		expect(manifest.spec).not.toHaveProperty("automountServiceAccountToken");
		const container = manifest.spec.containers[0];
		expect(container.volumeMounts).toContainEqual({
			name: "process-state",
			mountPath: "/process-storage",
		});
		expect(
			container.env.filter(({ name }) => name === "LEITWERK_PROCESS_VOLUME_MOUNT_PATH"),
		).toEqual([{ name: "LEITWERK_PROCESS_VOLUME_MOUNT_PATH", value: "/process-storage" }]);
	});

	it.each([
		"gvisor",
		"virtual-machine",
	] as const)("scopes %s guest privileges to Docker workers", (isolation) => {
		const options = {
			namespace: "leitwerk",
			docker: { runtimeClassName: "qualified-sandbox", isolation },
		};
		const pod = buildKubernetesWorkerPodManifest(
			startInput({
				docker: true,
				env: {
					LEITWERK_DOCKER_GVISOR: "1",
					LEITWERK_DOCKER_ISOLATION: "caller-selected",
				},
			}),
			options,
		);
		expect(pod.spec.runtimeClassName).toBe("qualified-sandbox");
		expect(pod.spec).not.toHaveProperty("hostUsers");
		if (isolation === "virtual-machine") {
			expect(pod.spec.automountServiceAccountToken).toBe(false);
		} else {
			expect(pod.spec).not.toHaveProperty("automountServiceAccountToken");
		}
		expect(pod.spec.containers[0].securityContext).toEqual({
			privileged: false,
			capabilities: {
				add:
					isolation === "virtual-machine"
						? ["SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE"]
						: ["SYS_ADMIN", "NET_ADMIN"],
			},
		});
		expect(pod.spec.containers[0].env.filter((e) => e.name === "LEITWERK_DOCKER_GVISOR")).toEqual(
			isolation === "gvisor" ? [{ name: "LEITWERK_DOCKER_GVISOR", value: "1" }] : [],
		);
		expect(
			pod.spec.containers[0].env.filter((e) => e.name === "LEITWERK_DOCKER_ISOLATION"),
		).toEqual(
			isolation === "virtual-machine"
				? [{ name: "LEITWERK_DOCKER_ISOLATION", value: "virtual-machine" }]
				: [],
		);
		expect(pod.spec.containers[0].env).toContainEqual({
			name: "DOCKER_HOST",
			value: "unix:///var/run/docker.sock",
		});
		for (const field of ["hostNetwork", "hostPID", "hostIPC"]) {
			expect(pod.spec).not.toHaveProperty(field);
		}
		expect(pod.spec.volumes).toEqual([
			{ name: "process-state", persistentVolumeClaim: { claimName: "leitwerk-process-proc-1" } },
		]);
		const ordinary = buildKubernetesWorkerPodManifest(startInput(), options);
		expect(ordinary.spec).not.toHaveProperty("runtimeClassName");
		expect(ordinary.spec).not.toHaveProperty("automountServiceAccountToken");
		expect(ordinary.spec.containers[0]).not.toHaveProperty("securityContext");
		expect(ordinary.spec.containers[0].env.some((e) => e.name === "LEITWERK_DOCKER_GVISOR")).toBe(
			false,
		);
		const helper = buildKubernetesExportHelperPodManifest(
			{
				instanceId: "PROC_1",
				exportId: "export-1",
				image: "ghcr.io/example/worker:1",
				command: ["helper"],
				env: {},
				volume: startInput().volume,
			},
			options,
		);
		expect(helper.spec).not.toHaveProperty("runtimeClassName");
		expect(helper.spec.containers[0]).not.toHaveProperty("securityContext");
	});

	it.each([
		false,
		true,
	])("strips caller-selected VM preparation outside trusted VM Docker starts: docker=%s", (docker) => {
		const env = { LEITWERK_DOCKER_ISOLATION: "virtual-machine" };
		for (const isolation of [undefined, "gvisor", "virtual-machine"] as const) {
			if (docker && isolation === "virtual-machine") continue;
			const pod = buildKubernetesWorkerPodManifest(startInput({ docker, env }), {
				namespace: "leitwerk",
				docker: {
					runtimeClassName: "qualified-sandbox",
					...(isolation ? { isolation } : { hostUsers: false }),
				},
			});
			expect(
				pod.spec.containers[0].env.some((entry) => entry.name === "LEITWERK_DOCKER_ISOLATION"),
			).toBe(false);
		}
		expect(env.LEITWERK_DOCKER_ISOLATION).toBe("virtual-machine");
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

	it("restricts helper PVC mounts to workspace and tree while retaining a read-only CA mount", () => {
		const manifest = buildKubernetesExportHelperPodManifest(
			{
				instanceId: "PROC_1",
				exportId: "exp_1",
				image: "example/worker:1",
				command: ["node", "/app/helper.js"],
				env: { LEITWERK_EXPORT_CREDENTIAL: "export-only-token" },
				volume: { instanceId: "PROC_1", id: "retained-state", mountPath: "/state" },
			},
			{
				namespace: "leitwerk-process-proc-1",
				serverCaConfigMap: {
					name: KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_NAME,
					key: KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_KEY,
					mountPath: KUBERNETES_WORKER_SERVER_CA_MOUNT_PATH,
				},
			},
		);
		const container = manifest.spec.containers[0];
		expect(container.volumeMounts).toEqual([
			{
				name: "process-state",
				mountPath: "/state/workspace",
				subPath: "workspace",
				readOnly: true,
			},
			{
				name: "process-state",
				mountPath: "/state/tree",
				subPath: "tree",
				readOnly: true,
			},
			{ name: "server-ca", mountPath: KUBERNETES_WORKER_SERVER_CA_MOUNT_PATH, readOnly: true },
		]);
		expect(container.env).toEqual([
			{ name: "LEITWERK_EXPORT_CREDENTIAL", value: "export-only-token" },
			{ name: "NODE_EXTRA_CA_CERTS", value: KUBERNETES_WORKER_SERVER_CA_CERT_PATH },
		]);
		expect(manifest.spec.automountServiceAccountToken).toBe(false);
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

	it("retains the latest attach failure despite earlier scheduling warnings and shuffled API order", () => {
		const events = [
			{
				type: "Warning",
				reason: "FailedScheduling",
				message: "unbound claim",
				eventTime: "2026-10-11T09:21:00Z",
			},
			{
				type: "Warning",
				reason: "FailedScheduling",
				message: "unbound claim",
				eventTime: "2026-10-11T09:21:02Z",
			},
			{
				type: "Normal",
				reason: "Scheduled",
				message: "assigned",
				eventTime: "2026-10-11T09:21:02Z",
			},
			{
				type: "Warning",
				reason: "FailedAttachVolume",
				message: "volume not ready",
				count: 8,
				firstTimestamp: "2026-10-11T09:21:03Z",
				lastTimestamp: "2026-10-11T09:22:10Z",
			},
		];
		const expected =
			"Kubernetes events: Warning FailedAttachVolume x8: volume not ready | Warning FailedScheduling: unbound claim | Normal Scheduled: assigned";
		expect(formatKubernetesPodDiagnostics(events)).toBe(expected);
		expect(formatKubernetesPodDiagnostics([events[2], events[0], events[3], events[1]])).toBe(
			expected,
		);
		expect(mapKubernetesPodExit({ reason: "Deleted", events }).reason).toContain(expected);
	});

	it("keeps newer container phase context ahead of old warnings", () => {
		const events = ["A", "B", "C"].map((reason) => ({
			type: "Warning",
			reason,
			eventTime: "2026-10-11T09:21:00Z",
		}));
		expect(
			formatKubernetesPodDiagnostics([
				...events,
				{ type: "Normal", reason: "Pulled", eventTime: "2026-10-11T09:22:00Z" },
				{ type: "Normal", reason: "Started", eventTime: "2026-10-11T09:22:10Z" },
			]),
		).toBe("Kubernetes events: Normal Started | Normal Pulled | Warning A");
	});

	it("uses modern recurrence counts and timestamps before legacy fields", () => {
		expect(
			formatKubernetesPodDiagnostics([
				{
					type: "Warning",
					reason: "Repeated",
					count: 2,
					lastTimestamp: "2026-10-11T09:21:00Z",
					series: { count: 9, lastObservedTime: "2026-10-11T09:23:00Z" },
				},
				{ type: "Normal", reason: "LaterThanLegacy", eventTime: "2026-10-11T09:22:00Z" },
			]),
		).toBe("Kubernetes events: Warning Repeated x9 | Normal LaterThanLegacy");
	});

	it("falls back through invalid timestamps and orders undated events deterministically", () => {
		const events = [
			{ type: "Normal", reason: "Z", message: "undated" },
			{ type: "Warning", reason: "B", eventTime: "invalid" },
			{ type: "Warning", reason: "A" },
			{
				type: "Normal",
				reason: "Dated",
				lastTimestamp: "invalid",
				firstTimestamp: "2026-10-11T09:22:00Z",
			},
		];
		const expected = "Kubernetes events: Normal Dated | Warning A | Warning B";
		expect(formatKubernetesPodDiagnostics(events)).toBe(expected);
		expect(formatKubernetesPodDiagnostics([...events].reverse())).toBe(expected);
	});

	it("deduplicates repeated diagnostics without exposing secrets or expanding the bounds", () => {
		const secret = "sensitive-value-12345";
		const events = [
			{
				type: "Warning",
				reason: "Repeated",
				message: `token=${secret}`,
				count: 2,
				eventTime: "2026-10-11T09:21:00Z",
			},
			{
				type: "Warning",
				reason: "Repeated",
				message: `token=${secret}`,
				count: 5,
				eventTime: "2026-10-11T09:22:00Z",
			},
			{ type: "Normal", reason: "Context", eventTime: "2026-10-11T09:21:30Z" },
		];
		const diagnostics = formatKubernetesPodDiagnostics(events, 2, [secret]);
		expect(diagnostics).toBe(
			"Kubernetes events: Warning Repeated x5: token=<redacted> | Normal Context",
		);
		expect(diagnostics).not.toContain(secret);
		expect(
			formatKubernetesPodDiagnostics(
				[{ ...events[1], message: `${secret}${"x".repeat(3_000)}` }],
				3,
				[secret],
			)?.length,
		).toBeLessThanOrEqual(2_048);
		expect(formatKubernetesPodDiagnostics(events, 0, [secret])).toBeUndefined();
	});
});
