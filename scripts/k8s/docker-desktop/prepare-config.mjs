#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";

function required(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

const source = required("SOURCE_CONFIG");
const output = required("OUTPUT_CONFIG");
const valuesOutput = required("OUTPUT_VALUES");
const namespace = required("SERVER_NAMESPACE");
const processPrefix = required("PROCESS_NAMESPACE_PREFIX");
const serverImage = required("SERVER_IMAGE");
const workerImage = required("WORKER_IMAGE");
const configSecret = required("CONFIG_SECRET");
const credentialSecret = required("CREDENTIAL_SECRET");
const publicPort = Number.parseInt(required("LEITWERK_PORT"), 10);
if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
	throw new Error("LEITWERK_PORT must be a valid TCP port");
}

const config = parse(readFileSync(source, "utf8"));
if (!config || typeof config !== "object") throw new Error("Source configuration must be a map");

config.server = {
	...(config.server ?? {}),
	host: "0.0.0.0",
	port: 8080,
	base_url: `http://127.0.0.1:${publicPort}`,
};
config.storage = {
	...(config.storage ?? {}),
	sqlite_path: "/var/lib/leitwerk/leitwerk.sqlite",
	process_workspaces_dir: "/var/lib/leitwerk/workspaces",
	tree_files_dir: "/var/lib/leitwerk/trees",
	artifacts_dir: "/var/lib/leitwerk/artifacts",
};
config.workers = {
	...(config.workers ?? {}),
	runner: "kubernetes",
	max_parallel_processes: Math.min(2, config.workers?.max_parallel_processes ?? 2),
	default_runtime_profile: "generic",
};
delete config.workers.command;
delete config.workers.args;
config.kubernetes = {
	server_namespace: namespace,
	process_namespace_prefix: processPrefix,
	server_url: `http://leitwerk-server.${namespace}.svc.cluster.local:8080`,
	default_worker_runtime_profile: "generic",
	worker_service_account: "leitwerk-worker",
	process_volume: {
		storage_class_name: "standard",
		size: "5Gi",
		access_modes: ["ReadWriteOnce"],
		mount_path: "/state",
	},
	pod: { node_selector: {}, tolerations: [], annotations: {} },
	image_pull_secrets: [],
};
config.worker_runtime_profiles = {
	generic: {
		image: workerImage,
		image_pull_policy: "Never",
		resources: {
			requests: { cpu: "250m", memory: "512Mi" },
			limits: { cpu: "1", memory: "2Gi" },
		},
	},
};
config.pi = { ...(config.pi ?? {}), agent_dir: "/var/lib/leitwerk/pi" };
config.extension_loading = {
	...(config.extension_loading ?? {}),
	discover_workspaces: false,
	sources: (config.extension_loading?.sources ?? []).map((sourcePath) => {
		if (typeof sourcePath !== "string") throw new Error("Extension sources must be strings");
		const match = sourcePath.replaceAll("\\", "/").match(/(?:^|\/)extensions\/([^/]+)\/?$/);
		if (!match) throw new Error(`Cannot map extension source into image: ${sourcePath}`);
		return `/app/extensions/${match[1]}`;
	}),
};

if (!config.extension_loading.sources.includes("/app/extensions/showcase-processes")) {
	throw new Error("Source configuration must load the showcase-processes extension");
}
if (!(config.pi?.model_profiles ?? []).some((profile) => typeof profile?.provider === "string")) {
	throw new Error("Source configuration must define at least one model profile");
}

const values = {
	namespace: { create: false, name: namespace },
	server: {
		existingConfigSecret: configSecret,
		credentialEncryption: {
			existingSecret: credentialSecret,
			key: "LEITWERK_CREDENTIAL_ENCRYPTION_KEY",
		},
		image: {
			repository: serverImage.slice(0, serverImage.lastIndexOf(":")),
			tag: serverImage.slice(serverImage.lastIndexOf(":") + 1),
			pullPolicy: "Never",
		},
		storage: { size: "2Gi", storageClassName: "standard", retain: true },
		resources: {
			requests: { cpu: "250m", memory: "512Mi" },
			limits: { cpu: "1", memory: "2Gi" },
		},
	},
	gateway: { enabled: true },
	kubernetes: {
		serverNamespace: namespace,
		processNamespacePrefix: processPrefix,
	},
};

for (const path of [output, valuesOutput]) mkdirSync(dirname(path), { recursive: true });
writeFileSync(output, stringify(config), { mode: 0o600 });
chmodSync(output, 0o600);
writeFileSync(valuesOutput, stringify(values), { mode: 0o600 });
chmodSync(valuesOutput, 0o600);
console.log(`Prepared deployment configuration in ${dirname(output)}`);
