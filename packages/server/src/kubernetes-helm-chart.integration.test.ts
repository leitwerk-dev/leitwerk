import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";
import { validateConfig } from "./config/config-loader.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const chartRoot = `${repoRoot}/deploy/kubernetes/helm/leitwerk`;
type JsonObject = Record<string, unknown>;

const helmEnv = {
	...process.env,
	HOME: process.env.LEITWERK_TEST_HOST_HOME ?? process.env.HOME,
};

function helmAvailable(): boolean {
	try {
		execFileSync("helm", ["version", "--short"], { stdio: "ignore", env: helmEnv });
		return true;
	} catch {
		return false;
	}
}

function helmJsonValues(values: Record<string, unknown>): string[] {
	return Object.entries(values).flatMap(([key, value]) => [
		"--set-json",
		`${key}=${JSON.stringify(value)}`,
	]);
}

function renderChart(extraArgs: string[]): unknown[] {
	const rendered = execFileSync(
		"helm",
		["template", "leitwerk", chartRoot, "--namespace", "leitwerk-k8s-test", ...extraArgs],
		{ encoding: "utf8", env: helmEnv },
	);
	return parseAllDocuments(rendered)
		.map((document) => document.toJSON())
		.filter(
			(document): document is Record<string, unknown> =>
				typeof document === "object" && document !== null,
		);
}

function findConfigMap(documents: unknown[]): Record<string, unknown> {
	const configMap = documents.find(
		(document): document is Record<string, unknown> =>
			typeof document === "object" &&
			document !== null &&
			(document as Record<string, unknown>).kind === "ConfigMap",
	);
	if (!configMap) {
		throw new Error("Rendered chart did not include a ConfigMap");
	}
	return configMap;
}

function findDocumentsByKind(documents: unknown[], kind: string): JsonObject[] {
	return documents.filter(
		(document): document is JsonObject =>
			typeof document === "object" && document !== null && (document as JsonObject).kind === kind,
	);
}

function namedDocument(documents: unknown[], kind: string, name: string): JsonObject {
	const document = findDocumentsByKind(documents, kind).find(
		(candidate) => (candidate.metadata as JsonObject)?.name === name,
	);
	if (!document) throw new Error(`Rendered chart did not include ${kind} ${name}`);
	return document;
}

function podSpec(document: JsonObject): JsonObject {
	return ((document.spec as JsonObject).template as JsonObject).spec as JsonObject;
}

function renderedLeitwerkConfig(documents: unknown[]): Record<string, unknown> {
	const configMap = findConfigMap(documents);
	const data = configMap.data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error("Rendered ConfigMap data must be an object");
	}
	const configText = (data as Record<string, unknown>)["leitwerk.yaml"];
	if (typeof configText !== "string") {
		throw new Error("Rendered ConfigMap must include leitwerk.yaml");
	}
	return parse(configText) as Record<string, unknown>;
}

const describeIfHelm = helmAvailable() ? describe : describe.skip;

describeIfHelm("Kubernetes Helm chart rendering", () => {
	it("templates a default Kubernetes-mode config accepted by the server validator", () => {
		const documents = renderChart([]);
		const config = renderedLeitwerkConfig(documents);

		expect(validateConfig(config)).toEqual([]);
		expect(config).toMatchObject({
			workers: { runner: "kubernetes" },
			kubernetes: {
				server_namespace: "leitwerk-k8s-test",
				process_namespace_prefix: "leitwerk-process-",
				server_url: "http://leitwerk-server.leitwerk-k8s-test.svc.cluster.local:8080",
			},
		});
	});

	it("templates internal TLS config and Kubernetes worker CA wiring when enabled", () => {
		const documents = renderChart([
			"--set",
			"internalTls.enabled=true",
			"--set",
			"internalTls.secretName=leitwerk-internal-tls",
		]);
		const config = renderedLeitwerkConfig(documents);

		expect(validateConfig(config)).toEqual([]);
		expect(config).toMatchObject({
			internal_tls: {
				enabled: true,
				cert_file: "/etc/leitwerk/internal-tls/tls.crt",
				key_file: "/etc/leitwerk/internal-tls/tls.key",
			},
			kubernetes: {
				server_url: "https://leitwerk-server.leitwerk-k8s-test.svc.cluster.local:8080",
				server_ca_file: "/etc/leitwerk/internal-tls/ca.crt",
			},
		});
	});

	it("templates cluster-scoped RBAC and admission policy for per-process namespaces", () => {
		const documents = renderChart([]);
		const clusterRoles = findDocumentsByKind(documents, "ClusterRole");
		const clusterRoleBindings = findDocumentsByKind(documents, "ClusterRoleBinding");
		const policies = findDocumentsByKind(documents, "ValidatingAdmissionPolicy");
		const bindings = findDocumentsByKind(documents, "ValidatingAdmissionPolicyBinding");

		expect(clusterRoles).toHaveLength(1);
		expect(clusterRoleBindings).toHaveLength(1);
		expect(policies).toHaveLength(1);
		expect(bindings).toHaveLength(1);
		expect(JSON.stringify(clusterRoles[0])).toContain("namespaces");
		expect(JSON.stringify(clusterRoles[0])).toContain("configmaps");
		expect(JSON.stringify(policies[0])).toContain("leitwerk-process-");
		expect(JSON.stringify(policies[0])).toContain("process-volume");
		expect(JSON.stringify(policies[0])).toContain("server-ca");
	});

	it("templates the Kind overlay with local worker profile images", () => {
		const documents = renderChart(["-f", `${chartRoot}/values-kind.yaml`]);
		const config = renderedLeitwerkConfig(documents);

		expect(validateConfig(config)).toEqual([]);
		expect(config).toMatchObject({
			workers: { runner: "kubernetes", idle_worker_ttl: "5s" },
			kubernetes: { process_namespace_prefix: "leitwerk-k8s-test-process-" },
			worker_runtime_profiles: {
				generic: { image: "leitwerk-worker-generic:dev" },
				"specialized-smoke": { image: "leitwerk-worker-specialized-smoke:dev" },
			},
		});
	});

	it("mounts external config and credential Secrets without rendering their contents", () => {
		const documents = renderChart([
			"--set",
			"server.existingConfigSecret=leitwerk-runtime-config",
			"--set",
			"server.credentialEncryption.existingSecret=leitwerk-credentials",
			"--set",
			"gateway.enabled=true",
			"--set",
			"server.storage.retain=true",
		]);
		const rendered = JSON.stringify(documents);
		const configMaps = findDocumentsByKind(documents, "ConfigMap");

		expect(configMaps).toHaveLength(1);
		expect(rendered).toContain("leitwerk-runtime-config");
		expect(rendered).toContain("leitwerk-credentials");
		expect(rendered).toContain("LEITWERK_CREDENTIAL_ENCRYPTION_KEY");
		expect(rendered).toContain("helm.sh/resource-policy");
		expect(rendered).toContain("copy-ui");
		expect(rendered).not.toContain("broker_token");
	});

	it("mounts an external server PVC without rendering a chart-owned PVC", () => {
		const documents = renderChart(["--set", "server.storage.existingClaim=leitwerk-server-data"]);
		const pvcs = findDocumentsByKind(documents, "PersistentVolumeClaim");
		const deployment = findDocumentsByKind(documents, "Deployment")[0];

		expect(pvcs).toHaveLength(0);
		expect(JSON.stringify(deployment)).toContain("leitwerk-server-data");
	});

	it("schedules the gateway with its configured selector, affinity, and tolerations", () => {
		const documents = renderChart([
			"--set",
			"gateway.enabled=true",
			"--set",
			"gateway.nodeSelector.example\\.com/node-role=workload",
			"--set",
			"gateway.tolerations[0].key=example.com/dedicated",
			"--set",
			"gateway.tolerations[0].operator=Equal",
			"--set",
			"gateway.tolerations[0].value=true",
			"--set",
			"gateway.tolerations[0].effect=NoSchedule",
			"--set",
			"gateway.affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution[0].weight=1",
		]);
		const gateway = findDocumentsByKind(documents, "Deployment").find(
			(document) => (document.metadata as Record<string, unknown>)?.name === "leitwerk-gateway",
		);
		const podSpec = ((
			(gateway?.spec as Record<string, unknown>).template as Record<string, unknown>
		).spec ?? {}) as Record<string, unknown>;

		expect(podSpec.nodeSelector).toEqual({ "example.com/node-role": "workload" });
		expect(podSpec.tolerations).toEqual([
			{
				key: "example.com/dedicated",
				operator: "Equal",
				value: true,
				effect: "NoSchedule",
			},
		]);
		expect(podSpec.affinity).toBeDefined();
	});

	it("renders host aliases, restricted security contexts, and additional environment wiring", () => {
		const documents = renderChart(
			helmJsonValues({
				"gateway.enabled": true,
				"server.hostAliases": [{ ip: "192.0.2.10", hostnames: ["model-api.example.test"] }],
				"kubernetes.pod.hostAliases": [
					{ ip: "2001:db8::10", hostnames: ["model-api-v6.example.test"] },
				],
				"server.podSecurityContext": {
					runAsNonRoot: true,
					fsGroup: 1000,
					seccompProfile: { type: "RuntimeDefault" },
				},
				"server.containerSecurityContext": {
					allowPrivilegeEscalation: false,
					capabilities: { drop: ["ALL"] },
				},
				"server.extraEnvFrom": [{ secretRef: { name: "model-provider-env" } }],
				"gateway.podSecurityContext": {
					runAsNonRoot: true,
					seccompProfile: { type: "RuntimeDefault" },
				},
				"gateway.initContainerSecurityContext": {
					allowPrivilegeEscalation: false,
					capabilities: { drop: ["ALL"] },
				},
				"gateway.containerSecurityContext": {
					allowPrivilegeEscalation: false,
					capabilities: { add: ["NET_BIND_SERVICE"], drop: ["ALL"] },
				},
				"gateway.extraEnv": [{ name: "XDG_DATA_HOME", value: "/tmp/caddy/data" }],
			}),
		);
		const config = renderedLeitwerkConfig(documents);
		const serverPod = podSpec(namedDocument(documents, "Deployment", "leitwerk-server"));
		const gatewayPod = podSpec(namedDocument(documents, "Deployment", "leitwerk-gateway"));

		expect(validateConfig(config)).toEqual([]);
		expect(config.kubernetes).toMatchObject({
			pod: {
				host_aliases: [{ ip: "2001:db8::10", hostnames: ["model-api-v6.example.test"] }],
			},
		});
		expect(serverPod).toMatchObject({
			hostAliases: [{ ip: "192.0.2.10", hostnames: ["model-api.example.test"] }],
			securityContext: {
				runAsNonRoot: true,
				fsGroup: 1000,
				seccompProfile: { type: "RuntimeDefault" },
			},
			containers: [
				{
					securityContext: {
						allowPrivilegeEscalation: false,
						capabilities: { drop: ["ALL"] },
					},
					envFrom: [{ secretRef: { name: "model-provider-env" } }],
				},
			],
		});
		expect(gatewayPod).toMatchObject({
			securityContext: {
				runAsNonRoot: true,
				seccompProfile: { type: "RuntimeDefault" },
			},
			initContainers: [
				{
					securityContext: {
						allowPrivilegeEscalation: false,
						capabilities: { drop: ["ALL"] },
					},
				},
			],
			containers: [
				{
					securityContext: {
						allowPrivilegeEscalation: false,
						capabilities: { add: ["NET_BIND_SERVICE"], drop: ["ALL"] },
					},
					env: [{ name: "XDG_DATA_HOME", value: "/tmp/caddy/data" }],
				},
			],
		});
	});

	it("omits optional Pod customizations from default chart output", () => {
		const documents = renderChart([]);
		const pod = podSpec(namedDocument(documents, "Deployment", "leitwerk-server"));
		const container = (pod.containers as Array<Record<string, unknown>>)[0];

		expect(pod).not.toHaveProperty("hostAliases");
		expect(pod).not.toHaveProperty("securityContext");
		expect(container).not.toHaveProperty("securityContext");
		expect(container).not.toHaveProperty("envFrom");
	});

	it("renders an opt-in pre-upgrade preflight and lifecycle-aware server probes", () => {
		const documents = renderChart(
			helmJsonValues({
				"server.preflight.enabled": true,
				"server.storage.existingClaim": "leitwerk-server-data",
				"server.existingConfigSecret": "leitwerk-runtime-config",
				"server.podSecurityContext": { runAsNonRoot: true },
				"server.containerSecurityContext": { allowPrivilegeEscalation: false },
				"server.extraEnvFrom": [{ secretRef: { name: "model-provider-env" } }],
			}),
		);
		const job = namedDocument(documents, "Job", "leitwerk-server-preflight");
		const deployment = namedDocument(documents, "Deployment", "leitwerk-server");
		const renderedJob = JSON.stringify(job);

		expect(job).toMatchObject({
			metadata: {
				annotations: {
					"helm.sh/hook": "pre-upgrade",
					"helm.sh/hook-delete-policy": "before-hook-creation,hook-succeeded",
				},
			},
			spec: { backoffLimit: 0 },
		});
		expect(renderedJob).toContain("--deployment-preflight");
		expect(renderedJob).toContain("leitwerk-server-data");
		expect(renderedJob).toContain('"readOnly":true');
		expect(renderedJob).toContain('"emptyDir":{}');
		expect(renderedJob).toContain("requiredDuringSchedulingIgnoredDuringExecution");
		const jobPod = podSpec(job);
		const preflight = (jobPod.containers as Array<Record<string, unknown>>)[0];
		expect(preflight.volumeMounts).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "data", readOnly: false })]),
		);
		expect(jobPod.securityContext).toEqual({ runAsNonRoot: true });
		expect(preflight.securityContext).toEqual({ allowPrivilegeEscalation: false });
		expect(preflight.envFrom).toEqual([{ secretRef: { name: "model-provider-env" } }]);
		const deploymentSpec = deployment.spec as JsonObject;
		const deploymentPod = podSpec(deployment);
		const server = (deploymentPod.containers as JsonObject[])[0];
		expect(deploymentSpec.strategy).toEqual({ type: "Recreate" });
		expect(deploymentPod.terminationGracePeriodSeconds).toBe(60);
		expect(server.readinessProbe).toMatchObject({ httpGet: { path: "/api/ready" } });
		expect(server.livenessProbe).toMatchObject({ httpGet: { path: "/api/health" } });
		expect(server.startupProbe).toMatchObject({ httpGet: { path: "/api/health" } });
	});

	it("renders least-privilege pull-Secret copying RBAC and admission constraints", () => {
		const documents = renderChart([
			"--set",
			"kubernetes.imagePullSecrets[0]=git-nifto-eu-pull",
			"--set",
			"kubernetes.imagePullSecretCopies[0].sourceName=git-nifto-eu-pull",
			"--set",
			"kubernetes.imagePullSecretCopies[0].targetName=git-nifto-eu-pull",
		]);
		const config = renderedLeitwerkConfig(documents);
		const roles = findDocumentsByKind(documents, "Role");
		const clusterRole = findDocumentsByKind(documents, "ClusterRole")[0];
		const policy = findDocumentsByKind(documents, "ValidatingAdmissionPolicy")[0];

		expect(validateConfig(config)).toEqual([]);
		expect(config.kubernetes).toMatchObject({
			image_pull_secrets: ["git-nifto-eu-pull"],
			image_pull_secret_copies: [
				{ source_name: "git-nifto-eu-pull", target_name: "git-nifto-eu-pull" },
			],
		});
		expect(roles).toHaveLength(1);
		expect(roles[0]).toMatchObject({
			rules: [{ resources: ["secrets"], resourceNames: ["git-nifto-eu-pull"], verbs: ["get"] }],
		});
		expect(clusterRole).toMatchObject({
			rules: expect.arrayContaining([
				expect.objectContaining({ resources: ["secrets"], verbs: ["create", "patch"] }),
			]),
		});
		const clusterSecretRules = (clusterRole.rules as Array<Record<string, unknown>>).filter(
			(rule) => Array.isArray(rule.resources) && rule.resources.includes("secrets"),
		);
		expect(clusterSecretRules).toEqual([
			expect.objectContaining({ resources: ["secrets"], verbs: ["create", "patch"] }),
		]);
		expect(JSON.stringify(policy)).toContain("git-nifto-eu-pull");
		expect(JSON.stringify(policy)).toContain("image-pull-secret");
		expect(JSON.stringify(policy)).toContain(".dockerconfigjson");
	});
});
