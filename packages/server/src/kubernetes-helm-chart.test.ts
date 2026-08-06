import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validateConfig } from "./config/config-loader.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const chartRoot = `${repoRoot}/deploy/kubernetes/helm/leitwerk`;

type JsonObject = Record<string, unknown>;

function readYaml(path: string): JsonObject {
	return parse(readFileSync(path, "utf8")) as JsonObject;
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeValues(base: JsonObject, overlay: JsonObject): JsonObject {
	const merged: JsonObject = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		if (isRecord(value) && isRecord(merged[key])) {
			merged[key] = mergeValues(merged[key], value);
			continue;
		}
		merged[key] = value;
	}
	return merged;
}

function requiredRecord(value: unknown, path: string): JsonObject {
	if (!isRecord(value)) {
		throw new TypeError(`${path} must be a record`);
	}
	return value;
}

function requiredString(value: unknown, path: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`${path} must be a string`);
	}
	return value;
}

function requiredNumber(value: unknown, path: string): number {
	if (typeof value !== "number") {
		throw new TypeError(`${path} must be a number`);
	}
	return value;
}

function requiredBoolean(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") {
		throw new TypeError(`${path} must be a boolean`);
	}
	return value;
}

function requiredArray(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new TypeError(`${path} must be an array`);
	}
	return value;
}

function buildConfigFromValues(values: JsonObject): JsonObject {
	const server = requiredRecord(values.server, "server");
	const serverConfig = requiredRecord(server.config, "server.config");
	const websocket = requiredRecord(serverConfig.websocket, "server.config.websocket");
	const storage = requiredRecord(server.storage, "server.storage");
	const workers = requiredRecord(values.workers, "workers");
	const cleanup = requiredRecord(workers.cleanup, "workers.cleanup");
	const kubernetes = requiredRecord(values.kubernetes, "kubernetes");
	const processVolume = requiredRecord(kubernetes.processVolume, "kubernetes.processVolume");
	const pod = requiredRecord(kubernetes.pod, "kubernetes.pod");
	const piRetry = requiredRecord(serverConfig.piRetry, "server.config.piRetry");
	const piRetryProvider = requiredRecord(piRetry.provider, "server.config.piRetry.provider");
	const extensionLoading = requiredRecord(
		serverConfig.extensionLoading,
		"server.config.extensionLoading",
	);
	const namespace = requiredRecord(values.namespace, "namespace");
	const namespaceName =
		requiredString(namespace.name, "namespace.name") ||
		requiredString(kubernetes.serverNamespace, "kubernetes.serverNamespace") ||
		"default";
	const service = requiredRecord(server.service, "server.service");
	const servicePort = requiredNumber(service.port, "server.service.port");
	const storageMount = requiredString(storage.mountPath, "server.storage.mountPath");
	const defaultWorkerRuntimeProfile = requiredString(
		kubernetes.defaultWorkerRuntimeProfile,
		"kubernetes.defaultWorkerRuntimeProfile",
	);
	return {
		server: {
			host: "0.0.0.0",
			port: servicePort,
			base_url: requiredString(serverConfig.baseUrl, "server.config.baseUrl"),
			websocket: {
				heartbeat_interval: requiredString(
					websocket.heartbeatInterval,
					"websocket.heartbeatInterval",
				),
				client_timeout: requiredString(websocket.clientTimeout, "websocket.clientTimeout"),
				toast_ttl: requiredString(websocket.toastTtl, "websocket.toastTtl"),
			},
		},
		storage: {
			sqlite_path: `${storageMount}/leitwerk.sqlite`,
			process_workspaces_dir: `${storageMount}/workspaces`,
			tree_files_dir: `${storageMount}/trees`,
			artifacts_dir: `${storageMount}/artifacts`,
		},
		components: requiredRecord(values.components, "components"),
		workers: {
			runner: "kubernetes",
			max_parallel_processes: requiredNumber(
				workers.maxParallelProcesses,
				"workers.maxParallelProcesses",
			),
			startup_timeout: requiredString(workers.startupTimeout, "workers.startupTimeout"),
			shutdown_grace_period: requiredString(
				workers.shutdownGracePeriod,
				"workers.shutdownGracePeriod",
			),
			heartbeat_interval: requiredString(workers.heartbeatInterval, "workers.heartbeatInterval"),
			resume_on_boot: requiredBoolean(workers.resumeOnBoot, "workers.resumeOnBoot"),
			idle_worker_ttl: requiredString(workers.idleWorkerTtl, "workers.idleWorkerTtl"),
			log_worker_events_to_stdout: requiredBoolean(
				serverConfig.logWorkerEventsToStdout,
				"server.config.logWorkerEventsToStdout",
			),
			command: "node",
			args: ["@leitwerk-dev/worker/worker-entry"],
			cleanup: {
				transient_ttl: requiredString(cleanup.transientTtl, "workers.cleanup.transientTtl"),
				completed_process_retention: requiredString(
					cleanup.completedProcessRetention,
					"workers.cleanup.completedProcessRetention",
				),
				error_process_retention: requiredString(
					cleanup.errorProcessRetention,
					"workers.cleanup.errorProcessRetention",
				),
			},
			turn_max_duration: requiredString(workers.turnMaxDuration, "workers.turnMaxDuration"),
			turn_inactivity_timeout: requiredString(
				workers.turnInactivityTimeout,
				"workers.turnInactivityTimeout",
			),
			turn_abort_grace_period: requiredString(
				workers.turnAbortGracePeriod,
				"workers.turnAbortGracePeriod",
			),
			stale_heartbeat_timeout: requiredString(
				workers.staleHeartbeatTimeout,
				"workers.staleHeartbeatTimeout",
			),
		},
		kubernetes: {
			server_namespace: namespaceName,
			process_namespace_prefix: requiredString(
				kubernetes.processNamespacePrefix,
				"kubernetes.processNamespacePrefix",
			),
			server_url:
				requiredString(kubernetes.serverUrl, "kubernetes.serverUrl") ||
				`http://leitwerk-server.${namespaceName}.svc.cluster.local:${servicePort}`,
			default_worker_runtime_profile: defaultWorkerRuntimeProfile,
			worker_service_account: requiredString(
				kubernetes.workerServiceAccount,
				"kubernetes.workerServiceAccount",
			),
			process_volume: {
				storage_class_name: requiredString(
					processVolume.storageClassName,
					"kubernetes.processVolume.storageClassName",
				),
				size: requiredString(processVolume.size, "kubernetes.processVolume.size"),
				access_modes: requiredArray(
					processVolume.accessModes,
					"kubernetes.processVolume.accessModes",
				),
				mount_path: requiredString(processVolume.mountPath, "kubernetes.processVolume.mountPath"),
			},
			pod: {
				node_selector: requiredRecord(pod.nodeSelector, "kubernetes.pod.nodeSelector"),
				tolerations: requiredArray(pod.tolerations, "kubernetes.pod.tolerations"),
				annotations: requiredRecord(pod.annotations, "kubernetes.pod.annotations"),
			},
			image_pull_secrets: requiredArray(kubernetes.imagePullSecrets, "kubernetes.imagePullSecrets"),
		},
		worker_runtime_profiles: requiredRecord(values.workerRuntimeProfiles, "workerRuntimeProfiles"),
		pi: {
			agent_dir: requiredString(serverConfig.piAgentDir, "server.config.piAgentDir"),
			retry: {
				enabled: requiredBoolean(piRetry.enabled, "server.config.piRetry.enabled"),
				max_retries: requiredNumber(piRetry.maxRetries, "server.config.piRetry.maxRetries"),
				base_delay: requiredString(piRetry.baseDelay, "server.config.piRetry.baseDelay"),
				provider: {
					timeout: piRetryProvider.timeout,
					max_retries: piRetryProvider.maxRetries,
					max_retry_delay: requiredString(
						piRetryProvider.maxRetryDelay,
						"server.config.piRetry.provider.maxRetryDelay",
					),
				},
			},
		},
		process_configs: requiredRecord(values.processConfigs, "processConfigs"),
		notifications: requiredRecord(values.notifications, "notifications"),
		sandbox: { enabled: false, profile: "" },
		extension_loading: {
			sources: requiredArray(extensionLoading.sources, "server.config.extensionLoading.sources"),
		},
		auth: requiredRecord(serverConfig.auth, "server.config.auth"),
	};
}

describe("Kubernetes Helm chart values", () => {
	it("render an leitwerk config shape that passes Kubernetes-mode validation", () => {
		const values = readYaml(`${chartRoot}/values.yaml`);
		const config = buildConfigFromValues(values);

		expect(validateConfig(config)).toEqual([]);
		expect(config.workers).toMatchObject({ runner: "kubernetes" });
		expect(Object.keys(requiredRecord(config.worker_runtime_profiles, "profiles"))).toEqual(
			expect.arrayContaining(["generic", "node22", "java21"]),
		);
	});

	it("keeps the Kind overlay self-contained for local image loading and worker profile selection", () => {
		const values = mergeValues(
			readYaml(`${chartRoot}/values.yaml`),
			readYaml(`${chartRoot}/values-kind.yaml`),
		);
		const config = buildConfigFromValues(values);

		expect(validateConfig(config)).toEqual([]);
		expect(requiredRecord(config.kubernetes, "kubernetes")).toMatchObject({
			server_namespace: "leitwerk-k8s-test",
			process_namespace_prefix: "leitwerk-k8s-test-process-",
			default_worker_runtime_profile: "generic",
		});
		expect(requiredRecord(config.worker_runtime_profiles, "profiles")).toMatchObject({
			generic: { image: "leitwerk-worker-generic:dev" },
			"specialized-smoke": { image: "leitwerk-worker-specialized-smoke:dev" },
		});
	});
});
