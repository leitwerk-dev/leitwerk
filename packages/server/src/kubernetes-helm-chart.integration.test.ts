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

let cachedDefaultRender: JsonObject[] | undefined;
function defaultRender() {
	cachedDefaultRender ??= renderChart();
	return structuredClone(cachedDefaultRender);
}

function renderChart(values: JsonObject = {}, extraArgs: string[] = []): JsonObject[] {
	const valueArgs = Object.entries(values).flatMap(([key, value]) => [
		"--set-json",
		`${key}=${JSON.stringify(value)}`,
	]);
	const rendered = execFileSync(
		"helm",
		[
			"template",
			"leitwerk",
			chartRoot,
			"--namespace",
			"leitwerk-k8s-test",
			...valueArgs,
			...extraArgs,
		],
		{ encoding: "utf8", env: helmEnv },
	);
	return parseAllDocuments(rendered)
		.map((document) => document.toJSON())
		.filter(
			(document): document is Record<string, unknown> =>
				typeof document === "object" && document !== null,
		);
}

function findDocumentsByKind(documents: JsonObject[], kind: string): JsonObject[] {
	return documents.filter((document) => document.kind === kind);
}

function namedDocument(documents: JsonObject[], kind: string, name: string): JsonObject {
	const document = findDocumentsByKind(documents, kind).find(
		(candidate) => (candidate.metadata as JsonObject)?.name === name,
	);
	if (!document) throw new Error(`Rendered chart did not include ${kind} ${name}`);
	return document;
}

function podSpec(document: JsonObject): JsonObject {
	return ((document.spec as JsonObject).template as JsonObject).spec as JsonObject;
}

function renderedLeitwerkConfig(documents: JsonObject[]): Record<string, unknown> {
	const configMap = namedDocument(documents, "ConfigMap", "leitwerk-server-config");
	expect(configMap.data).toMatchObject({ "leitwerk.yaml": expect.any(String) });
	return parse((configMap.data as Record<string, string>)["leitwerk.yaml"]) as JsonObject;
}

const describeIfHelm = helmAvailable() ? describe : describe.skip;

describeIfHelm("Kubernetes Helm chart rendering", () => {
	it("templates a default Kubernetes-mode config accepted by the server validator", () => {
		const documents = defaultRender();
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

	it("templates trusted Kubernetes Docker wiring only when enabled", () => {
		const defaultConfig = renderedLeitwerkConfig(defaultRender());
		expect((defaultConfig.kubernetes as JsonObject).docker).toBeUndefined();

		const config = renderedLeitwerkConfig(
			renderChart({
				"kubernetes.docker.enabled": true,
				"kubernetes.docker.runtimeClassName": "leitwerk-sysbox",
				"kubernetes.docker.hostUsers": false,
				"kubernetes.docker.processStorageClassName": "leitwerk-docker-process",
			}),
		);

		expect(validateConfig(config)).toEqual([]);
		expect(config).toMatchObject({
			kubernetes: {
				docker: {
					runtime_class_name: "leitwerk-sysbox",
					host_users: false,
					process_storage_class_name: "leitwerk-docker-process",
				},
			},
		});
	});

	it("templates internal TLS config and Kubernetes worker CA wiring when enabled", () => {
		const documents = renderChart({
			"internalTls.enabled": true,
			"internalTls.secretName": "leitwerk-internal-tls",
		});
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
		const documents = defaultRender();
		const clusterRoles = findDocumentsByKind(documents, "ClusterRole");
		const clusterRoleBindings = findDocumentsByKind(documents, "ClusterRoleBinding");
		const policies = findDocumentsByKind(documents, "ValidatingAdmissionPolicy");
		const bindings = findDocumentsByKind(documents, "ValidatingAdmissionPolicyBinding");

		expect(clusterRoles).toHaveLength(1);
		expect(clusterRoleBindings).toHaveLength(1);
		expect(policies).toHaveLength(1);
		expect(bindings).toHaveLength(1);
		const roleRules = clusterRoles[0].rules as JsonObject[];
		expect(
			roleRules.find((rule) => (rule.resources as string[]).includes("namespaces"))?.verbs,
		).toEqual(expect.arrayContaining(["create", "get", "list", "delete"]));
		expect(
			roleRules.find((rule) => (rule.resources as string[]).includes("configmaps"))?.verbs,
		).toEqual(expect.arrayContaining(["create", "get", "list", "watch", "patch"]));
		expect(clusterRoleBindings[0]).toMatchObject({
			roleRef: { kind: "ClusterRole", name: "leitwerk-server" },
			subjects: [
				{ kind: "ServiceAccount", name: "leitwerk-server", namespace: "leitwerk-k8s-test" },
			],
		});
		expect(JSON.stringify(policies[0])).toContain("leitwerk-process-");
		expect(JSON.stringify(policies[0])).toContain("process-volume");
		expect(JSON.stringify(policies[0])).toContain("server-ca");
	});

	it.each([
		false,
		true,
	])("restricts process resources and scopes preparation exceptions (pre-provisioning: %s)", (preProvision) => {
		const documents = renderChart({
			"kubernetes.processVolume.preProvision.enabled": preProvision,
			"kubernetes.processVolume.storageClassName": "csi-storage",
			"kubernetes.workerServiceAccount": "custom-worker",
		});
		const rendered = findDocumentsByKind(documents, "ValidatingAdmissionPolicy")[0];
		const spec = rendered.spec as JsonObject;
		expect(spec.failurePolicy).toBe("Fail");
		expect(JSON.stringify(spec.matchConditions)).toContain(
			"system:serviceaccount:leitwerk-k8s-test:leitwerk-server",
		);
		expect(spec.matchConstraints).toEqual({
			resourceRules: [
				{
					apiGroups: [""],
					apiVersions: ["v1"],
					operations: ["CREATE", "UPDATE", "DELETE"],
					resources: [
						"namespaces",
						"pods",
						"persistentvolumeclaims",
						"serviceaccounts",
						"configmaps",
						"secrets",
					],
				},
			],
		});
		const rules = spec.validations as Array<{ expression: string; message: string }>;

		for (const fragment of [
			"process-namespace",
			"process-volume",
			"server-ca",
			"worker-service-account",
			"custom-worker",
			"leitwerk.dev/instance-id",
			"leitwerk.dev/worker-id",
			"leitwerk.dev/server-epoch",
			"session-export-helper",
			"leitwerk.dev/export-id",
			"image-pull-secret",
			".dockerconfigjson",
		]) {
			expect(
				rules.some((rule) => rule.expression.includes(fragment)),
				fragment,
			).toBe(true);
		}
		const exceptions = rules.filter((rule) =>
			rule.expression.endsWith(" || variables.isPreparation"),
		);
		const exceptionSubjects = [
			"metadata.namespace.startsWith",
			"variables.component == 'process-volume'",
			"variables.component in ['worker', 'session-export-helper']",
			"spec.serviceAccountName",
			"'leitwerk.dev/instance-id'",
			"'leitwerk.dev/worker-id'",
			"'leitwerk.dev/server-epoch'",
			"'leitwerk.dev/export-id'",
		];
		expect(exceptions).toHaveLength(preProvision ? exceptionSubjects.length : 0);
		if (preProvision)
			for (const subject of exceptionSubjects)
				expect(
					exceptions.filter((rule) => rule.expression.includes(subject)),
					subject,
				).toHaveLength(1);

		if (preProvision) {
			expect(JSON.stringify(spec.variables)).toContain(
				"variables.resource.metadata.namespace == 'leitwerk-k8s-test'",
			);
			expect(
				rules.find((rule) =>
					rule.expression.includes("!variables.resource.spec.automountServiceAccountToken"),
				)?.expression,
			).toContain("variables.resource.spec.serviceAccountName == 'default'");
		} else expect(JSON.stringify(spec)).not.toContain("isPreparation");
		expect(findDocumentsByKind(documents, "ValidatingAdmissionPolicyBinding")[0].spec).toEqual({
			policyName: "leitwerk-server-process-resources",
			validationActions: ["Deny"],
		});
	});

	it("templates the Kind overlay with local worker profile images", () => {
		const documents = renderChart({}, ["-f", `${chartRoot}/values-kind.yaml`]);
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
		const documents = renderChart({
			"server.existingConfigSecret": "leitwerk-runtime-config",
			"server.credentialEncryption.existingSecret": "leitwerk-credentials",
			"gateway.enabled": true,
			"server.storage.retain": true,
		});
		const rendered = JSON.stringify(documents);
		const configMaps = findDocumentsByKind(documents, "ConfigMap");

		expect(configMaps).toHaveLength(1);
		const serverPod = podSpec(namedDocument(documents, "Deployment", "leitwerk-server"));
		expect(
			(serverPod.volumes as JsonObject[]).find((volume) => volume.name === "config")?.secret,
		).toEqual({
			secretName: "leitwerk-runtime-config",
			items: [{ key: "leitwerk.yaml", path: "leitwerk.yaml" }],
		});
		const server = (serverPod.containers as JsonObject[])[0];
		expect(
			(server.volumeMounts as JsonObject[]).find((mount) => mount.name === "config"),
		).toMatchObject({ mountPath: "/etc/leitwerk", readOnly: true });
		expect(
			(server.env as JsonObject[]).find(
				(entry) => entry.name === "LEITWERK_CREDENTIAL_ENCRYPTION_KEY",
			)?.valueFrom,
		).toEqual({
			secretKeyRef: { name: "leitwerk-credentials", key: "LEITWERK_CREDENTIAL_ENCRYPTION_KEY" },
		});
		expect(rendered).toContain("helm.sh/resource-policy");
		expect(rendered).toContain("copy-ui");
		expect(rendered).not.toContain("broker_token");
	});

	it("mounts an external server PVC without rendering a chart-owned PVC", () => {
		const documents = renderChart({ "server.storage.existingClaim": "leitwerk-server-data" });
		const pvcs = findDocumentsByKind(documents, "PersistentVolumeClaim");
		const deployment = findDocumentsByKind(documents, "Deployment")[0];

		expect(pvcs).toHaveLength(0);
		const pod = podSpec(deployment);
		expect(
			(pod.volumes as JsonObject[]).find((volume) => volume.name === "data")?.persistentVolumeClaim,
		).toEqual({ claimName: "leitwerk-server-data" });
		expect(
			((pod.containers as JsonObject[])[0].volumeMounts as JsonObject[]).find(
				(mount) => mount.name === "data",
			)?.mountPath,
		).toBe("/var/lib/leitwerk");
	});

	it("schedules the gateway with its configured selector, affinity, and tolerations", () => {
		const values = {
			"gateway.enabled": true,
			"gateway.nodeSelector": { "example.com/node-role": "workload" },
			"gateway.tolerations": [
				{ key: "example.com/dedicated", operator: "Equal", value: true, effect: "NoSchedule" },
			],
			"gateway.affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution": [
				{ weight: 1 },
			],
		};
		const documents = renderChart(values);
		const gatewayPod = podSpec(namedDocument(documents, "Deployment", "leitwerk-gateway"));

		expect(gatewayPod.nodeSelector).toEqual(values["gateway.nodeSelector"]);
		expect(gatewayPod.tolerations).toEqual(values["gateway.tolerations"]);
		expect(gatewayPod.affinity).toEqual({
			nodeAffinity: {
				preferredDuringSchedulingIgnoredDuringExecution:
					values["gateway.affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution"],
			},
		});
	});

	it("renders host aliases, restricted security contexts, and additional environment wiring", () => {
		const values = {
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
		};
		const documents = renderChart(values);
		const config = renderedLeitwerkConfig(documents);
		const serverPod = podSpec(namedDocument(documents, "Deployment", "leitwerk-server"));
		const gatewayPod = podSpec(namedDocument(documents, "Deployment", "leitwerk-gateway"));

		expect(validateConfig(config)).toEqual([]);
		expect(config.kubernetes).toMatchObject({
			pod: { host_aliases: values["kubernetes.pod.hostAliases"] },
		});
		expect(serverPod).toMatchObject({
			hostAliases: values["server.hostAliases"],
			securityContext: values["server.podSecurityContext"],
			containers: [
				{
					securityContext: values["server.containerSecurityContext"],
					envFrom: values["server.extraEnvFrom"],
				},
			],
		});
		expect(gatewayPod).toMatchObject({
			securityContext: values["gateway.podSecurityContext"],
			initContainers: [{ securityContext: values["gateway.initContainerSecurityContext"] }],
			containers: [
				{
					securityContext: values["gateway.containerSecurityContext"],
					env: values["gateway.extraEnv"],
				},
			],
		});
	});

	it("omits optional Pod customizations from default chart output", () => {
		const documents = defaultRender();
		const pod = podSpec(namedDocument(documents, "Deployment", "leitwerk-server"));
		const container = (pod.containers as Array<Record<string, unknown>>)[0];

		expect(pod).not.toHaveProperty("hostAliases");
		expect(pod).not.toHaveProperty("securityContext");
		expect(container).not.toHaveProperty("securityContext");
		expect(container).not.toHaveProperty("envFrom");
	});

	it("renders an opt-in pre-upgrade preflight and lifecycle-aware server probes", () => {
		const documents = renderChart({
			"server.preflight.enabled": true,
			"server.storage.existingClaim": "leitwerk-server-data",
			"server.existingConfigSecret": "leitwerk-runtime-config",
			"server.podSecurityContext": { runAsNonRoot: true },
			"server.containerSecurityContext": { allowPrivilegeEscalation: false },
			"server.extraEnvFrom": [{ secretRef: { name: "model-provider-env" } }],
		});
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

		expect(renderedJob).toContain("requiredDuringSchedulingIgnoredDuringExecution");
		const jobPod = podSpec(job);
		const preflight = (jobPod.containers as Array<Record<string, unknown>>)[0];
		expect(jobPod.volumes).toEqual(
			expect.arrayContaining([
				{ name: "scratch", emptyDir: {} },
				{ name: "data", persistentVolumeClaim: { claimName: "leitwerk-server-data" } },
				{
					name: "config",
					secret: {
						secretName: "leitwerk-runtime-config",
						items: [{ key: "leitwerk.yaml", path: "leitwerk.yaml" }],
					},
				},
			]),
		);
		expect(preflight.volumeMounts).toEqual(
			expect.arrayContaining([
				{ name: "config", mountPath: "/etc/leitwerk", readOnly: true },
				{ name: "scratch", mountPath: "/var/lib/leitwerk-preflight" },
			]),
		);
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
		const documents = renderChart({
			"kubernetes.imagePullSecrets": ["git-nifto-eu-pull"],
			"kubernetes.imagePullSecretCopies": [
				{ sourceName: "git-nifto-eu-pull", targetName: "git-nifto-eu-pull" },
			],
		});
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

	it.each([false, true])("wires volume pre-provisioning config and permissions: %s", (enabled) => {
		const documents = renderChart({
			"kubernetes.processVolume.preProvision.enabled": enabled,
			"kubernetes.processVolume.preProvision.count": 3,
			"kubernetes.processVolume.storageClassName": "csi-storage",
		});
		const config = renderedLeitwerkConfig(documents);
		expect(((config.kubernetes as JsonObject).process_volume as JsonObject).pre_provision).toEqual(
			enabled ? { count: 3 } : undefined,
		);
		const role = findDocumentsByKind(documents, "ClusterRole")[0];
		const rules = role.rules as Array<{ resources: string[]; verbs: string[] }>;
		expect(rules.some((rule) => rule.resources.includes("persistentvolumes"))).toBe(enabled);
		expect(rules.some((rule) => rule.resources.includes("storageclasses"))).toBe(enabled);
		expect(findDocumentsByKind(documents, "DaemonSet")).toEqual([]);
		const policy = findDocumentsByKind(documents, "ValidatingAdmissionPolicy")[0];
		expect(JSON.stringify(policy).includes("isPreparation")).toBe(enabled);
	});
});
