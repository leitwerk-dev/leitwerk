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
		{ encoding: "utf8" },
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
});
