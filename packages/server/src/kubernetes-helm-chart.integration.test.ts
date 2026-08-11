import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";
import { validateConfig } from "./config/config-loader.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const chartRoot = `${repoRoot}/deploy/kubernetes/helm/leitwerk`;

function helmAvailable(): boolean {
	try {
		execFileSync("bash", ["-lc", "command -v helm >/dev/null && helm version --short >/dev/null"], {
			stdio: "ignore",
			env: {
				...process.env,
				HOME: process.env.LEITWERK_TEST_HOST_HOME ?? process.env.HOME,
			},
		});
		return true;
	} catch {
		return false;
	}
}

function renderChart(extraArgs: string[]): unknown[] {
	const quotedArgs = extraArgs.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
	const rendered = execFileSync(
		"bash",
		[
			"-lc",
			`helm template leitwerk '${chartRoot.replaceAll("'", "'\\''")}' --namespace leitwerk-k8s-test ${quotedArgs}`,
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				HOME: process.env.LEITWERK_TEST_HOST_HOME ?? process.env.HOME,
			},
		},
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

function findDocumentsByKind(documents: unknown[], kind: string): Record<string, unknown>[] {
	return documents.filter(
		(document): document is Record<string, unknown> =>
			typeof document === "object" &&
			document !== null &&
			(document as Record<string, unknown>).kind === kind,
	);
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
		const documents = renderChart([
			"--set",
			"gateway.enabled=true",
			"--set",
			"server.hostAliases[0].ip=192.0.2.10",
			"--set",
			"server.hostAliases[0].hostnames[0]=model-api.example.test",
			"--set",
			"kubernetes.pod.hostAliases[0].ip=2001:db8::10",
			"--set",
			"kubernetes.pod.hostAliases[0].hostnames[0]=model-api-v6.example.test",
			"--set",
			"server.podSecurityContext.runAsNonRoot=true",
			"--set",
			"server.podSecurityContext.fsGroup=1000",
			"--set",
			"server.podSecurityContext.seccompProfile.type=RuntimeDefault",
			"--set",
			"server.containerSecurityContext.allowPrivilegeEscalation=false",
			"--set",
			"server.containerSecurityContext.capabilities.drop[0]=ALL",
			"--set",
			"server.extraEnvFrom[0].secretRef.name=model-provider-env",
			"--set",
			"gateway.podSecurityContext.runAsNonRoot=true",
			"--set",
			"gateway.podSecurityContext.seccompProfile.type=RuntimeDefault",
			"--set",
			"gateway.initContainerSecurityContext.allowPrivilegeEscalation=false",
			"--set",
			"gateway.initContainerSecurityContext.capabilities.drop[0]=ALL",
			"--set",
			"gateway.containerSecurityContext.allowPrivilegeEscalation=false",
			"--set",
			"gateway.containerSecurityContext.capabilities.drop[0]=ALL",
			"--set",
			"gateway.containerSecurityContext.capabilities.add[0]=NET_BIND_SERVICE",
			"--set",
			"gateway.extraEnv[0].name=XDG_DATA_HOME",
			"--set",
			"gateway.extraEnv[0].value=/tmp/caddy/data",
		]);
		const config = renderedLeitwerkConfig(documents);
		const deployments = findDocumentsByKind(documents, "Deployment");
		const server = deployments.find(
			(document) => (document.metadata as Record<string, unknown>)?.name === "leitwerk-server",
		);
		const gateway = deployments.find(
			(document) => (document.metadata as Record<string, unknown>)?.name === "leitwerk-gateway",
		);
		const serverPod = (
			(server?.spec as Record<string, unknown>).template as Record<string, unknown>
		).spec as Record<string, unknown>;
		const gatewayPod = (
			(gateway?.spec as Record<string, unknown>).template as Record<string, unknown>
		).spec as Record<string, unknown>;
		const serverContainer = (serverPod.containers as Array<Record<string, unknown>>)[0];
		const gatewayContainer = (gatewayPod.containers as Array<Record<string, unknown>>)[0];
		const gatewayInit = (gatewayPod.initContainers as Array<Record<string, unknown>>)[0];

		expect(validateConfig(config)).toEqual([]);
		expect(config.kubernetes).toMatchObject({
			pod: {
				host_aliases: [{ ip: "2001:db8::10", hostnames: ["model-api-v6.example.test"] }],
			},
		});
		expect(serverPod.hostAliases).toEqual([
			{ ip: "192.0.2.10", hostnames: ["model-api.example.test"] },
		]);
		expect(serverPod.securityContext).toMatchObject({
			runAsNonRoot: true,
			fsGroup: 1000,
			seccompProfile: { type: "RuntimeDefault" },
		});
		expect(serverContainer.securityContext).toEqual({
			allowPrivilegeEscalation: false,
			capabilities: { drop: ["ALL"] },
		});
		expect(serverContainer.envFrom).toEqual([{ secretRef: { name: "model-provider-env" } }]);
		expect(gatewayPod.securityContext).toMatchObject({
			runAsNonRoot: true,
			seccompProfile: { type: "RuntimeDefault" },
		});
		expect(gatewayInit.securityContext).toEqual({
			allowPrivilegeEscalation: false,
			capabilities: { drop: ["ALL"] },
		});
		expect(gatewayContainer.securityContext).toEqual({
			allowPrivilegeEscalation: false,
			capabilities: { add: ["NET_BIND_SERVICE"], drop: ["ALL"] },
		});
		expect(gatewayContainer.env).toEqual([{ name: "XDG_DATA_HOME", value: "/tmp/caddy/data" }]);
	});

	it("omits optional Pod customizations from default chart output", () => {
		const deployments = findDocumentsByKind(renderChart([]), "Deployment");
		const server = deployments[0];
		const pod = ((server.spec as Record<string, unknown>).template as Record<string, unknown>)
			.spec as Record<string, unknown>;
		const container = (pod.containers as Array<Record<string, unknown>>)[0];

		expect(pod).not.toHaveProperty("hostAliases");
		expect(pod).not.toHaveProperty("securityContext");
		expect(container).not.toHaveProperty("securityContext");
		expect(container).not.toHaveProperty("envFrom");
	});

	it("renders an opt-in pre-upgrade preflight and lifecycle-aware server probes", () => {
		const documents = renderChart([
			"--set",
			"server.preflight.enabled=true",
			"--set",
			"server.storage.existingClaim=leitwerk-server-data",
			"--set",
			"server.existingConfigSecret=leitwerk-runtime-config",
			"--set",
			"server.podSecurityContext.runAsNonRoot=true",
			"--set",
			"server.containerSecurityContext.allowPrivilegeEscalation=false",
			"--set",
			"server.extraEnvFrom[0].secretRef.name=model-provider-env",
		]);
		const job = findDocumentsByKind(documents, "Job")[0];
		const deployment = findDocumentsByKind(documents, "Deployment")[0];
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
		const jobPod = ((job.spec as Record<string, unknown>).template as Record<string, unknown>)
			.spec as Record<string, unknown>;
		const preflight = (jobPod.containers as Array<Record<string, unknown>>)[0];
		expect(jobPod.securityContext).toEqual({ runAsNonRoot: true });
		expect(preflight.securityContext).toEqual({ allowPrivilegeEscalation: false });
		expect(preflight.envFrom).toEqual([{ secretRef: { name: "model-provider-env" } }]);
		const deploymentSpec = deployment.spec as Record<string, unknown>;
		const podSpec = ((deploymentSpec.template as Record<string, unknown>).spec ?? {}) as Record<
			string,
			unknown
		>;
		const server = (podSpec.containers as Array<Record<string, unknown>>)[0];
		expect(deploymentSpec.strategy).toEqual({ type: "Recreate" });
		expect(podSpec.terminationGracePeriodSeconds).toBe(60);
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
