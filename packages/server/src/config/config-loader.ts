import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { DEFAULT_SESSION_TRANSFER_LIMITS } from "@leitwerk-dev/session-transfer";
import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import { createDefu } from "defu";
import * as v from "valibot";
import { parse as parseYaml } from "yaml";
import { normalizeRepositoryLocator } from "../commit-message-policy.js";
import { SAFE_SKILL_ID_PATTERN } from "../skills/skill-id.js";
import type { LeitwerkConfig, ModelProfile } from "./config-types.js";
import { isHttpsOrLoopbackHttpUrl, isValidHttpUrl, parseHttpUrl } from "./url-policy.js";

const DEFAULT_SEARCH_PATHS = ["./leitwerk.yaml", "~/.leitwerk/leitwerk.yaml"];
const REDACTED_LOG_VALUE = "<redacted>";
const SENSITIVE_CONFIG_KEY_PATTERN =
	/(token|secret|password|passphrase|api[_-]?key|private[_-]?key|known[_-]?hosts|webhook)/i;
const DEFAULT_MODEL_PROFILES: ModelProfile[] = [];
const positiveSafeInteger = v.pipe(
	v.number(),
	v.integer(),
	v.minValue(1),
	v.maxValue(Number.MAX_SAFE_INTEGER),
);

export interface ConfigLoadResult {
	ok: true;
	config: LeitwerkConfig;
	filePath: string;
}

export interface ConfigLoadError {
	ok: false;
	error: string;
}

type ConfigIssue = {
	path: string;
	message: string;
};

function expandHome(p: string): string {
	if (p.startsWith("~/")) {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
		return resolve(home, p.slice(2));
	}
	return resolve(p);
}

function describeType(value: unknown): string {
	if (Array.isArray(value)) {
		return "array";
	}
	if (value === null) {
		return "null";
	}
	return typeof value;
}

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

const mergeConfigDefaults = createDefu((object, key, value) => {
	if (Array.isArray(object[key]) && Array.isArray(value)) {
		object[key] = value;
		return true;
	}
	return false;
});

function mergeConfigValue(defaultValue: unknown, overrideValue: unknown): unknown {
	return mergeConfigDefaults(
		cloneValue(overrideValue) as Record<string, unknown>,
		cloneValue(defaultValue) as Record<string, unknown>,
	);
}

export function applyConfigDefaults(raw: Record<string, unknown>): LeitwerkConfig {
	const merged = mergeConfigValue(getDefaultConfig(), raw) as LeitwerkConfig;
	if (Object.hasOwn(raw, "worker_runtime_profiles")) {
		merged.worker_runtime_profiles =
			raw.worker_runtime_profiles as LeitwerkConfig["worker_runtime_profiles"];
	}
	return merged;
}

export function resolveConfigPath(explicitPath?: string): string | null {
	if (explicitPath) {
		const expanded = expandHome(explicitPath);
		return existsSync(expanded) ? expanded : null;
	}
	for (const candidate of DEFAULT_SEARCH_PATHS) {
		const expanded = expandHome(candidate);
		if (existsSync(expanded)) return expanded;
	}
	return null;
}

export function loadConfigFromFile(filePath: string): ConfigLoadResult | ConfigLoadError {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsedYaml = parseYaml(raw);
		const parsed = parsedYaml === null ? {} : parsedYaml;
		const parsedRecord = v.safeParse(unknownRecordSchema, parsed);
		if (!parsedRecord.success) {
			return {
				ok: false,
				error: `Config validation errors:\nExpected object at <root>, got ${describeType(parsed)}`,
			};
		}
		const config = applyConfigDefaults(parsedRecord.output);
		const errors = validateResolvedConfig(config as unknown as Record<string, unknown>);
		if (errors.length > 0) {
			return { ok: false, error: `Config validation errors:\n${errors.join("\n")}` };
		}
		return { ok: true, config, filePath };
	} catch (err) {
		return { ok: false, error: `Failed to load config from ${filePath}: ${err}` };
	}
}

export function loadConfig(explicitPath?: string): ConfigLoadResult | ConfigLoadError {
	const filePath = resolveConfigPath(explicitPath);
	if (!filePath) {
		return { ok: true, config: getDefaultConfig(), filePath: "<defaults>" };
	}
	return loadConfigFromFile(filePath);
}

const stringArraySchema = v.array(v.string());
const unknownRecordSchema = v.pipe(
	v.unknown(),
	v.check(
		(value) => typeof value === "object" && value !== null && !Array.isArray(value),
		"Expected object",
	),
	v.record(v.string(), v.unknown()),
);

const modelTurnConfigSchema = v.looseObject({
	model_profile: v.optional(v.string()),
});

const authNonEmptyString = v.pipe(v.string(), v.nonEmpty());

const authOidcProviderSchema = v.looseObject({
	id: authNonEmptyString,
	kind: v.literal("oidc"),
	issuer: authNonEmptyString,
	client_id: authNonEmptyString,
	client_secret: authNonEmptyString,
	redirect_uri: v.optional(authNonEmptyString),
	scopes: v.optional(v.pipe(stringArraySchema, v.nonEmpty())),
	identity_claim: v.optional(authNonEmptyString),
});

const authGithubProviderSchema = v.looseObject({
	id: v.literal("github"),
	kind: v.literal("oauth2"),
	client_id: authNonEmptyString,
	client_secret: authNonEmptyString,
	organization: authNonEmptyString,
	redirect_uri: v.optional(authNonEmptyString),
});

const authConfigSchema = v.looseObject({
	enabled: v.optional(v.boolean()),
	session: v.optional(
		v.looseObject({
			cookie_name: v.optional(authNonEmptyString),
			ttl: v.optional(authNonEmptyString),
		}),
	),
	providers: v.optional(
		v.array(v.variant("kind", [authOidcProviderSchema, authGithubProviderSchema])),
	),
	allowlist: v.optional(stringArraySchema),
});

const safeSkillIdSchema = v.pipe(v.string(), v.regex(SAFE_SKILL_ID_PATTERN));
const kubernetesHostAliasIpSchema = v.pipe(
	v.string(),
	v.nonEmpty(),
	v.check((value) => isIP(value) !== 0, "Expected an IPv4 or IPv6 address"),
);
const kubernetesHostnameSchema = v.pipe(
	v.string(),
	v.nonEmpty(),
	v.maxLength(253),
	v.regex(
		/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u,
		"Expected a lowercase DNS hostname",
	),
);
const skillRepositorySchema = v.strictObject({
	id: safeSkillIdSchema,
	label: v.optional(v.pipe(v.string(), v.nonEmpty())),
	url: v.pipe(v.string(), v.nonEmpty()),
	ref: v.pipe(v.string(), v.nonEmpty()),
	path: v.optional(v.pipe(v.string(), v.nonEmpty())),
});

const configSchema = v.looseObject({
	skill_repositories: v.optional(v.array(skillRepositorySchema)),
	commit_messages: v.optional(
		v.strictObject({
			templates: v.record(v.string(), v.strictObject({ rules: v.pipe(v.string(), v.nonEmpty()) })),
			default_template: v.optional(v.nullable(v.pipe(v.string(), v.nonEmpty()))),
			repositories: v.record(v.string(), v.pipe(v.string(), v.nonEmpty())),
		}),
	),
	session_transfer: v.optional(
		v.strictObject({
			max_entries: v.pipe(
				v.number(),
				v.integer(),
				v.minValue(3),
				v.maxValue(Number.MAX_SAFE_INTEGER),
			),
			max_logical_bytes: positiveSafeInteger,
			max_compressed_bytes: positiveSafeInteger,
		}),
	),
	server: v.looseObject({
		host: v.string(),
		port: v.number(),
		base_url: v.string(),
		websocket: v.looseObject({
			heartbeat_interval: v.string(),
			client_timeout: v.string(),
			toast_ttl: v.string(),
		}),
	}),
	storage: v.looseObject({
		sqlite_path: v.string(),
		process_workspaces_dir: v.string(),
		tree_files_dir: v.string(),
	}),
	components: v.record(
		v.string(),
		v.looseObject({
			repo: v.string(),
			default_branch: v.string(),
			worker_runtime_profile: v.optional(v.string()),
		}),
	),
	development_tools: v.looseObject({
		install_timeout: v.string(),
		local: v.looseObject({ mise_command: v.string() }),
	}),
	workers: v.looseObject({
		runner: v.optional(v.picklist(["docker", "kubernetes", "local"])),
		default_runtime_profile: v.optional(v.string()),
		max_parallel_processes: v.number(),
		startup_timeout: v.string(),
		shutdown_grace_period: v.string(),
		heartbeat_interval: v.string(),
		turn_max_duration: v.string(),
		turn_inactivity_timeout: v.string(),
		turn_abort_grace_period: v.string(),
		stale_heartbeat_timeout: v.string(),
		resume_on_boot: v.boolean(),
		idle_worker_ttl: v.string(),
		session_snapshot_max_size_bytes: v.optional(v.number()),
		log_worker_events_to_stdout: v.boolean(),
		cleanup: v.looseObject({
			transient_ttl: v.string(),
			completed_process_retention: v.string(),
			error_process_retention: v.string(),
		}),
	}),
	local_worker: v.optional(
		v.looseObject({
			command: v.string(),
			args: stringArraySchema,
		}),
	),
	pi: v.looseObject({
		agent_dir: v.string(),
		model_profiles: v.array(
			v.looseObject({
				id: v.string(),
				provider: v.string(),
				model_id: v.string(),
				thinking_level: v.optional(v.string()),
				provider_options: v.optional(v.record(v.string(), v.string())),
			}),
		),
		system_prompt_template: v.optional(v.string()),
		process_title_generation: v.looseObject({
			model_profile: v.nullable(v.string()),
			retry: v.looseObject({
				max_attempts: v.pipe(v.number(), v.integer(), v.minValue(1)),
				base_delay: v.string(),
				max_delay: v.string(),
			}),
		}),
		retry: v.looseObject({
			enabled: v.boolean(),
			max_retries: v.number(),
			base_delay: v.string(),
			provider: v.looseObject({
				timeout: v.nullable(v.string()),
				max_retries: v.nullable(v.number()),
				max_retry_delay: v.string(),
			}),
		}),
	}),
	process_configs: v.optional(
		v.record(
			v.string(),
			v.looseObject({
				default_model_profile: v.optional(v.string()),
				allowed_model_profiles: v.optional(v.pipe(stringArraySchema, v.nonEmpty())),
				worker_runtime_profile: v.optional(v.string()),
				pi: v.optional(
					v.looseObject({
						system_prompt_template: v.optional(v.string()),
						append_system_prompt_template: v.optional(v.string()),
					}),
				),
				turn_configs: v.optional(v.record(v.string(), modelTurnConfigSchema)),
				watchers: v.optional(v.record(v.string(), v.unknown())),
			}),
		),
	),
	notifications: v.looseObject({
		all: v.looseObject({ enabled: v.boolean(), type: v.string(), url: v.string() }),
		debug: v.looseObject({ enabled: v.boolean(), type: v.string(), url: v.string() }),
		squad: v.looseObject({
			enabled: v.boolean(),
			type: v.string(),
			routing_field: v.string(),
			routes: v.record(v.string(), v.looseObject({ url: v.string() })),
		}),
	}),
	sandbox: v.looseObject({ enabled: v.boolean(), profile: v.string() }),
	extension_loading: v.looseObject({
		sources: stringArraySchema,
	}),
	auth: v.optional(authConfigSchema),
	docker: v.optional(
		v.looseObject({
			socket: v.string(),
			network: v.string(),
			server_url: v.string(),
			server_ca_file: v.optional(v.string()),
			process_volume: v.looseObject({
				mode: v.picklist(["bind", "named_volume"]),
				host_root: v.string(),
				mount_path: v.string(),
			}),
			dind: v.optional(
				v.looseObject({
					privileged: v.boolean(),
					sysbox: v.boolean(),
					sysbox_runtime: v.optional(v.string()),
				}),
			),
		}),
	),
	kubernetes: v.optional(
		v.looseObject({
			server_namespace: v.string(),
			process_namespace_prefix: v.string(),
			server_url: v.string(),
			server_ca_file: v.optional(v.string()),
			api_server_url: v.optional(v.string()),
			default_worker_runtime_profile: v.optional(v.string()),
			worker_service_account: v.optional(v.string()),
			process_volume: v.looseObject({
				storage_class_name: v.optional(v.string()),
				size: v.string(),
				access_modes: stringArraySchema,
				mount_path: v.string(),
			}),
			pod: v.optional(
				v.looseObject({
					node_selector: v.optional(v.record(v.string(), v.string())),
					tolerations: v.optional(v.array(v.unknown())),
					annotations: v.optional(v.record(v.string(), v.string())),
					host_aliases: v.optional(
						v.array(
							v.strictObject({
								ip: kubernetesHostAliasIpSchema,
								hostnames: v.pipe(v.array(kubernetesHostnameSchema), v.nonEmpty()),
							}),
						),
					),
				}),
			),
			image_pull_secrets: v.optional(stringArraySchema),
			image_pull_secret_copies: v.optional(
				v.array(
					v.strictObject({
						source_name: v.pipe(v.string(), v.nonEmpty()),
						target_name: v.pipe(v.string(), v.nonEmpty()),
					}),
				),
			),
		}),
	),
	worker_runtime_profiles: v.optional(
		v.record(
			v.string(),
			v.looseObject({
				image: v.string(),
				image_pull_policy: v.optional(v.string()),
				resources: v.optional(
					v.looseObject({
						cpu: v.optional(v.string()),
						memory: v.optional(v.string()),
						limits: v.optional(
							v.looseObject({ cpu: v.optional(v.string()), memory: v.optional(v.string()) }),
						),
					}),
				),
				dind: v.optional(v.picklist(["privileged", "sysbox"])),
			}),
		),
	),
	internal_tls: v.optional(
		v.looseObject({
			enabled: v.boolean(),
			cert_file: v.optional(v.string()),
			key_file: v.optional(v.string()),
			client_ca_file: v.optional(v.string()),
		}),
	),
	extensions: unknownRecordSchema,
});

function formatValibotPath(issue: v.BaseIssue<unknown>): string {
	if (!issue.path || issue.path.length === 0) {
		return "<root>";
	}
	let formatted = "";
	for (const item of issue.path) {
		const key = item.key;
		if (typeof key === "number") {
			formatted += `[${key}]`;
			continue;
		}
		if (formatted.length > 0) {
			formatted += ".";
		}
		formatted += String(key);
	}
	return formatted;
}

function formatConfigSchemaIssue(issue: v.BaseIssue<unknown>): ConfigIssue {
	const path = formatValibotPath(issue);
	if (issue.type === "non_empty") {
		return { path, message: `${path} must not be empty when specified` };
	}
	return { path, message: `${path}: ${issue.message}` };
}

function collectConfigSchemaErrors(config: unknown): string[] {
	const parsed = v.safeParse(configSchema, config, { abortEarly: false });
	if (parsed.success) {
		return [];
	}
	return parsed.issues.map((issue) => formatConfigSchemaIssue(issue).message);
}

function collectModelProfileReferenceErrors(config: LeitwerkConfig): string[] {
	const errors: string[] = [];
	const configuredModelProfileIds = new Set(
		config.pi.model_profiles
			.map((profile) => profile.id)
			.filter((profileId) => typeof profileId === "string" && profileId.trim() !== ""),
	);
	const titleModelProfile = config.pi.process_title_generation.model_profile;
	if (typeof titleModelProfile === "string") {
		if (titleModelProfile.trim() === "") {
			errors.push(
				"pi.process_title_generation.model_profile must be a non-empty string when specified",
			);
		} else if (!configuredModelProfileIds.has(titleModelProfile)) {
			errors.push(
				`Unknown model profile '${titleModelProfile}' at pi.process_title_generation.model_profile`,
			);
		}
	}
	for (const [processId, processConfig] of Object.entries(config.process_configs ?? {})) {
		const processConfigPath = `process_configs.${processId}`;
		if (processConfig.allowed_model_profiles !== undefined) {
			for (const [index, profileId] of processConfig.allowed_model_profiles.entries()) {
				const allowedProfilePath = `${processConfigPath}.allowed_model_profiles[${index}]`;
				if (typeof profileId !== "string" || profileId.trim() === "") {
					continue;
				}
				if (!configuredModelProfileIds.has(profileId)) {
					errors.push(`Unknown model profile '${profileId}' at ${allowedProfilePath}`);
				}
			}
		}
	}
	return errors;
}

function isValidPositiveDuration(value: string): boolean {
	return parseDurationMs(value, -1, { allowHours: true }) > 0;
}

function collectServerBaseUrlErrors(config: LeitwerkConfig): string[] {
	return isValidHttpUrl(config.server.base_url)
		? []
		: ["server.base_url must be an absolute http(s) URL"];
}

function collectWorkerRuntimeProfileErrors(config: LeitwerkConfig): string[] {
	const errors: string[] = [];
	const profileIds = new Set(Object.keys(config.worker_runtime_profiles ?? {}));
	const checkReference = (value: string | undefined, path: string) => {
		if (typeof value !== "string" || value.trim() === "") {
			return;
		}
		if (!profileIds.has(value)) {
			errors.push(`Unknown worker runtime profile '${value}' at ${path}`);
		}
	};
	for (const [id, profile] of Object.entries(config.worker_runtime_profiles ?? {})) {
		if (typeof profile.image !== "string" || profile.image.trim() === "") {
			errors.push(`worker_runtime_profiles.${id}.image must be a non-empty string`);
		}
	}
	// Local is intentionally best-effort and does not consume image/profile
	// selection. Keep Docker/Kubernetes as the contract-defining profile users.
	if (config.workers.runner === "local") {
		return errors;
	}
	checkReference(config.workers.default_runtime_profile, "workers.default_runtime_profile");
	if (config.workers.runner === "kubernetes") {
		checkReference(
			config.kubernetes?.default_worker_runtime_profile,
			"kubernetes.default_worker_runtime_profile",
		);
	}
	for (const [key, component] of Object.entries(config.components)) {
		checkReference(component.worker_runtime_profile, `components.${key}.worker_runtime_profile`);
	}
	for (const [processId, processConfig] of Object.entries(config.process_configs ?? {})) {
		checkReference(
			processConfig.worker_runtime_profile,
			`process_configs.${processId}.worker_runtime_profile`,
		);
	}
	return errors;
}

function collectWorkersConfigErrors(config: LeitwerkConfig): string[] {
	const errors: string[] = [];
	if (!isValidPositiveDuration(config.development_tools.install_timeout)) {
		errors.push("development_tools.install_timeout must be a positive duration");
	}
	if (config.development_tools.local.mise_command.trim() === "") {
		errors.push("development_tools.local.mise_command must be a non-empty string");
	}
	const maxSnapshotBytes = config.workers.session_snapshot_max_size_bytes;
	if (
		maxSnapshotBytes !== undefined &&
		(!Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes <= 0)
	) {
		errors.push("workers.session_snapshot_max_size_bytes must be a positive safe integer");
	}
	return errors;
}

function collectLocalRunnerConfigErrors(config: LeitwerkConfig): string[] {
	if (config.workers.runner !== "local") return [];
	const errors: string[] = [];
	const local = config.local_worker;
	if (!local) return ["local_worker config block is required when workers.runner is 'local'"];
	requireNonEmpty("local_worker", { command: local.command }, errors);
	if (!Array.isArray(local.args)) errors.push("local_worker.args must be an array");
	for (const [id, profile] of Object.entries(config.worker_runtime_profiles ?? {})) {
		if (profile.dind !== undefined) {
			errors.push(
				`worker_runtime_profiles.${id}.dind is not supported when workers.runner is 'local'`,
			);
		}
	}
	return errors;
}

function collectDockerRunnerConfigErrors(config: LeitwerkConfig): string[] {
	if (config.workers.runner !== "docker") {
		return [];
	}
	const errors: string[] = [];
	const docker = config.docker;
	if (!docker) {
		return ["docker config block is required when workers.runner is 'docker'"];
	}
	if (Object.keys(config.worker_runtime_profiles ?? {}).length === 0) {
		errors.push(
			"worker_runtime_profiles must include at least one profile when workers.runner is 'docker'",
		);
	}
	if (!config.workers.default_runtime_profile?.trim()) {
		errors.push("workers.default_runtime_profile is required when workers.runner is 'docker'");
	}
	if (!isValidHttpUrl(docker.server_url)) {
		errors.push("docker.server_url must be an absolute http(s) URL");
	}
	errors.push(
		...collectProductionWorkerTransportSecurityErrors({
			runner: "docker",
			serverUrl: docker.server_url,
			serverCaFile: docker.server_ca_file,
			internalTlsEnabled: config.internal_tls?.enabled === true,
		}),
	);
	errors.push(...collectWorkerDindCapabilityErrors(config));
	return errors;
}

function collectProductionWorkerTransportSecurityErrors(input: {
	runner: "docker" | "kubernetes";
	serverUrl: string;
	serverCaFile?: string;
	internalTlsEnabled: boolean;
}): string[] {
	const errors: string[] = [];
	const parsed = parseHttpUrl(input.serverUrl);
	if (!parsed) {
		return errors;
	}
	const prefix = input.runner;
	if (input.internalTlsEnabled) {
		if (parsed.protocol !== "https:") {
			errors.push(`${prefix}.server_url must use https when internal_tls.enabled is true`);
		}
		if (!input.serverCaFile?.trim()) {
			errors.push(
				`${prefix}.server_ca_file is required when internal_tls.enabled is true and workers.runner is '${input.runner}'`,
			);
		}
		return errors;
	}
	if (parsed.protocol !== "http:") {
		errors.push(`${prefix}.server_url must use http when internal_tls.enabled is false`);
	}
	return errors;
}

function isSafeKubernetesNamespacePrefix(value: string): boolean {
	return /^(?!-)[a-z0-9-]+-$/.test(value) && value.length <= 40;
}

function isSafeKubernetesDnsLabel(value: string): boolean {
	return /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(value);
}

function requireNonEmpty(
	prefix: string,
	fields: Record<string, string | undefined>,
	errors: string[],
): void {
	for (const [key, value] of Object.entries(fields)) {
		if (typeof value !== "string" || value.trim() === "")
			errors.push(`${prefix}.${key} must be a non-empty string`);
	}
}

function collectKubernetesRunnerConfigErrors(config: LeitwerkConfig): string[] {
	if (config.workers.runner !== "kubernetes") return [];
	const errors: string[] = [];
	const k = config.kubernetes;
	if (!k) return ["kubernetes config block is required when workers.runner is 'kubernetes'"];

	requireNonEmpty(
		"kubernetes",
		{ server_namespace: k.server_namespace, server_url: k.server_url },
		errors,
	);
	requireNonEmpty(
		"kubernetes.process_volume",
		{ size: k.process_volume.size, mount_path: k.process_volume.mount_path },
		errors,
	);

	if (k.server_namespace.trim() && !isSafeKubernetesDnsLabel(k.server_namespace))
		errors.push("kubernetes.server_namespace must be a safe DNS label");
	if (!k.process_namespace_prefix.trim())
		errors.push("kubernetes.process_namespace_prefix must be a non-empty string");
	else if (!isSafeKubernetesNamespacePrefix(k.process_namespace_prefix))
		errors.push(
			"kubernetes.process_namespace_prefix must contain only lowercase DNS-label characters and end with '-'",
		);
	if (
		k.server_namespace.trim() &&
		k.process_namespace_prefix.trim() &&
		k.server_namespace.startsWith(k.process_namespace_prefix)
	)
		errors.push(
			"kubernetes.server_namespace must be dedicated and must not match the process namespace prefix",
		);
	if (!isValidHttpUrl(k.server_url))
		errors.push("kubernetes.server_url must be an absolute http(s) URL");
	errors.push(
		...collectProductionWorkerTransportSecurityErrors({
			runner: "kubernetes",
			serverUrl: k.server_url,
			serverCaFile: k.server_ca_file,
			internalTlsEnabled: config.internal_tls?.enabled === true,
		}),
	);
	if (k.api_server_url !== undefined && !isValidHttpUrl(k.api_server_url))
		errors.push("kubernetes.api_server_url must be an absolute http(s) URL");

	if (Object.keys(config.worker_runtime_profiles ?? {}).length === 0)
		errors.push(
			"worker_runtime_profiles must include at least one profile when workers.runner is 'kubernetes'",
		);
	const defaultProfile = k.default_worker_runtime_profile ?? config.workers.default_runtime_profile;
	if (!defaultProfile?.trim())
		errors.push(
			"kubernetes.default_worker_runtime_profile or workers.default_runtime_profile is required when workers.runner is 'kubernetes'",
		);
	if (k.process_volume.access_modes.length === 0)
		errors.push("kubernetes.process_volume.access_modes must not be empty");

	for (const [id, profile] of Object.entries(config.worker_runtime_profiles ?? {})) {
		if (profile.dind !== undefined)
			errors.push(
				`worker_runtime_profiles.${id}.dind is not supported when workers.runner is 'kubernetes'`,
			);
	}
	return errors;
}

/**
 * Rejects DinD opt-in on a runtime profile unless the host runtime advertises
 * the matching capability under `docker.dind`. This is the config-time gate the
 * plan calls for: "DinD opt-in is rejected unless the runtime supports it."
 */
function collectWorkerDindCapabilityErrors(config: LeitwerkConfig): string[] {
	const errors: string[] = [];
	const cap = config.docker?.dind;
	for (const [id, profile] of Object.entries(config.worker_runtime_profiles ?? {})) {
		const mode = profile.dind;
		if (!mode) continue;
		const enabled = mode === "privileged" ? cap?.privileged : cap?.sysbox;
		if (!enabled) {
			errors.push(
				`worker_runtime_profiles.${id}.dind is '${mode}' but docker.dind.${mode} is not enabled`,
			);
			continue;
		}
		if (mode === "sysbox" && !cap?.sysbox_runtime?.trim())
			errors.push(
				`worker_runtime_profiles.${id}.dind is 'sysbox' but docker.dind.sysbox_runtime is not configured`,
			);
	}
	return errors;
}

function collectInternalTlsConfigErrors(config: LeitwerkConfig): string[] {
	const tls = config.internal_tls;
	if (!tls?.enabled) return [];
	const errors: string[] = [];
	requireNonEmpty("internal_tls", { cert_file: tls.cert_file, key_file: tls.key_file }, errors);
	if (tls.client_ca_file?.trim()) {
		errors.push(
			"internal_tls.client_ca_file is not supported for worker IPC yet; workers do not receive client certificate/key material",
		);
	}
	return errors.map((e) =>
		e.replace("must be a non-empty string", "is required when internal_tls.enabled is true"),
	);
}

function collectAuthConfigErrors(config: LeitwerkConfig): string[] {
	const errors: string[] = [];
	const auth = config.auth;
	if (!auth || auth.enabled !== true) {
		return errors;
	}
	const providers = auth.providers ?? [];
	if (providers.length === 0) {
		errors.push(
			"auth.providers must include one authentication provider when auth.enabled is true",
		);
	}
	if (providers.length > 1) {
		errors.push("auth.providers currently supports exactly one provider");
	}
	if (providers.length > 0 && !isHttpsOrLoopbackHttpUrl(config.server.base_url)) {
		errors.push("server.base_url must use https when auth is enabled, except for localhost");
	}
	for (const [index, provider] of providers.entries()) {
		if (provider.kind === "oidc" && !isHttpsOrLoopbackHttpUrl(provider.issuer)) {
			errors.push(
				`auth.providers[${index}].issuer must be an absolute https URL, except for localhost`,
			);
		}
		if (provider.redirect_uri !== undefined && !isHttpsOrLoopbackHttpUrl(provider.redirect_uri)) {
			errors.push(
				`auth.providers[${index}].redirect_uri must be an absolute https URL, except for localhost`,
			);
		}
	}
	if (auth.session?.ttl !== undefined && !isValidPositiveDuration(auth.session.ttl)) {
		errors.push("auth.session.ttl must be a positive duration");
	}
	return errors;
}

function hasOwnKey(value: unknown, key: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.hasOwn(value, key)
	);
}

function collectLegacyConfigKeyErrors(config: Record<string, unknown>): string[] {
	const errors = Object.hasOwn(config, "skills")
		? ["skills was removed; configure Git sources through skill_repositories"]
		: [];
	const legacyKeys = [
		{
			section: "pi",
			key: "process_dir",
			message: "pi.process_dir was renamed to pi.agent_dir; move the configured value",
		},
		{
			section: "local_worker",
			key: "process_volume_root",
			message:
				"local_worker.process_volume_root was removed; remove the key because local workers use storage.process_workspaces_dir and storage.tree_files_dir directly",
		},
	] as const;
	errors.push(
		...legacyKeys
			.filter(({ section, key }) => hasOwnKey(config[section], key))
			.map(({ message }) => message),
	);
	return errors;
}

function collectCommitMessageConfigErrors(config: LeitwerkConfig): string[] {
	const section = config.commit_messages;
	if (!section) return [];
	const errors: string[] = [];
	const templateIds = new Set(Object.keys(section.templates));
	if (section.default_template && !templateIds.has(section.default_template)) {
		errors.push(
			`Unknown commit-message template '${section.default_template}' at commit_messages.default_template`,
		);
	}
	const normalized = new Map<string, string>();
	for (const [locator, templateId] of Object.entries(section.repositories)) {
		if (!templateIds.has(templateId)) {
			errors.push(
				`Unknown commit-message template '${templateId}' at commit_messages.repositories.${locator}`,
			);
		}
		const key = normalizeRepositoryLocator(locator);
		if (!key) {
			errors.push("commit_messages repository locators must be non-empty");
			continue;
		}
		const prior = normalized.get(key);
		if (prior && prior !== templateId) {
			errors.push(`Conflicting commit-message mappings normalize to repository locator '${key}'`);
		} else {
			normalized.set(key, templateId);
		}
	}
	return errors;
}

function validateResolvedConfig(config: Record<string, unknown>): string[] {
	const legacyKeyErrors = collectLegacyConfigKeyErrors(config);
	if (legacyKeyErrors.length > 0) {
		return legacyKeyErrors;
	}
	const shapeErrors = collectConfigSchemaErrors(config);
	if (shapeErrors.length > 0) {
		return shapeErrors;
	}
	const resolvedConfig = config as unknown as LeitwerkConfig;
	const skillErrors: string[] = [];
	const repositoryIds = new Set<string>();
	for (const repository of resolvedConfig.skill_repositories ?? []) {
		if (repositoryIds.has(repository.id)) {
			skillErrors.push(`Duplicate skill repository id '${repository.id}' at skill_repositories`);
		}
		repositoryIds.add(repository.id);
	}
	return [
		...skillErrors,
		...collectServerBaseUrlErrors(resolvedConfig),
		...collectCommitMessageConfigErrors(resolvedConfig),
		...collectModelProfileReferenceErrors(resolvedConfig),
		...collectWorkerRuntimeProfileErrors(resolvedConfig),
		...collectWorkersConfigErrors(resolvedConfig),
		...collectLocalRunnerConfigErrors(resolvedConfig),
		...collectDockerRunnerConfigErrors(resolvedConfig),
		...collectKubernetesRunnerConfigErrors(resolvedConfig),
		...collectInternalTlsConfigErrors(resolvedConfig),
		...collectAuthConfigErrors(resolvedConfig),
	];
}

export function validateConfig(raw: Record<string, unknown>): string[] {
	const config = applyConfigDefaults(raw);
	return validateResolvedConfig(config as unknown as Record<string, unknown>);
}

function shouldRedactForLogging(path: readonly string[], key: string): boolean {
	if (SENSITIVE_CONFIG_KEY_PATTERN.test(key)) {
		return true;
	}
	if (path[0] === "notifications" && key === "url") {
		return true;
	}
	if (key === "url" && path.some((segment) => /webhook/i.test(segment))) {
		return true;
	}
	return false;
}

function redactLoggedValue(value: unknown): unknown {
	if (typeof value === "string" && value.length === 0) {
		return "";
	}
	return REDACTED_LOG_VALUE;
}

export function sanitizeConfigForLogging(value: unknown, path: readonly string[] = []): unknown {
	if (Array.isArray(value)) {
		return value.map((entry, index) => sanitizeConfigForLogging(entry, [...path, String(index)]));
	}
	const parsedRecord = v.safeParse(unknownRecordSchema, value);
	if (!parsedRecord.success) {
		return value;
	}

	const sanitized: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(parsedRecord.output)) {
		if (shouldRedactForLogging(path, key)) {
			sanitized[key] = redactLoggedValue(entry);
			continue;
		}
		sanitized[key] = sanitizeConfigForLogging(entry, [...path, key]);
	}
	return sanitized;
}

export function getDefaultConfig(): LeitwerkConfig {
	return {
		skill_repositories: [],
		commit_messages: {
			templates: {},
			default_template: null,
			repositories: {},
		},
		session_transfer: {
			max_entries: DEFAULT_SESSION_TRANSFER_LIMITS.maxEntries,
			max_logical_bytes: DEFAULT_SESSION_TRANSFER_LIMITS.maxLogicalBytes,
			max_compressed_bytes: DEFAULT_SESSION_TRANSFER_LIMITS.maxCompressedBytes,
		},
		server: {
			host: "127.0.0.1",
			port: 8080,
			base_url: "http://127.0.0.1:8080",
			websocket: { heartbeat_interval: "10s", client_timeout: "30s", toast_ttl: "6s" },
		},
		storage: {
			sqlite_path: ":memory:",
			process_workspaces_dir: "/tmp/leitwerk/workspaces",
			tree_files_dir: "/tmp/leitwerk/trees",
		},
		components: {},
		development_tools: {
			install_timeout: "30m",
			local: { mise_command: "mise" },
		},
		workers: {
			runner: "docker",
			default_runtime_profile: "generic",
			max_parallel_processes: 8,
			startup_timeout: "30s",
			shutdown_grace_period: "15s",
			heartbeat_interval: "5s",
			turn_max_duration: "30m",
			turn_inactivity_timeout: "5m",
			turn_abort_grace_period: "5s",
			stale_heartbeat_timeout: "30s",
			resume_on_boot: true,
			idle_worker_ttl: "0s",
			session_snapshot_max_size_bytes: 128 * 1024 * 1024,
			log_worker_events_to_stdout: false,
			cleanup: {
				transient_ttl: "1h",
				completed_process_retention: "168h",
				error_process_retention: "720h",
			},
		},
		pi: {
			agent_dir: "~/.pi/leitwerk",
			model_profiles: cloneValue(DEFAULT_MODEL_PROFILES),
			process_title_generation: {
				model_profile: null,
				retry: {
					max_attempts: 6,
					base_delay: "5s",
					max_delay: "5m",
				},
			},
			retry: {
				enabled: true,
				max_retries: 3,
				base_delay: "2s",
				provider: {
					timeout: null,
					max_retries: null,
					max_retry_delay: "60s",
				},
			},
		},
		process_configs: {},
		notifications: {
			all: { enabled: false, type: "teams_webhook", url: "" },
			debug: { enabled: false, type: "teams_webhook", url: "" },
			squad: { enabled: false, type: "teams_webhook", routing_field: "", routes: {} },
		},
		sandbox: { enabled: false, profile: "" },
		extension_loading: {
			sources: [],
		},
		local_worker: {
			command: "node",
			args: ["@leitwerk-dev/worker/worker-entry"],
		},
		docker: {
			socket: "unix:///var/run/docker.sock",
			network: "leitwerk",
			server_url: "http://leitwerk-server:8080",
			process_volume: {
				mode: "bind",
				host_root: "/var/lib/leitwerk/processes",
				mount_path: "/state",
			},
		},
		kubernetes: {
			server_namespace: "leitwerk-system",
			process_namespace_prefix: "leitwerk-process-",
			server_url: "http://leitwerk-server.leitwerk-system.svc.cluster.local:8080",
			default_worker_runtime_profile: "generic",
			worker_service_account: "leitwerk-worker",
			process_volume: {
				size: "20Gi",
				access_modes: ["ReadWriteOnce"],
				mount_path: "/state",
			},
			pod: { node_selector: {}, tolerations: [], annotations: {}, host_aliases: [] },
			image_pull_secrets: [],
			image_pull_secret_copies: [],
		},
		worker_runtime_profiles: {
			generic: { image: "ghcr.io/example/leitwerk-worker-generic:0.1.0" },
		},
		internal_tls: { enabled: false },
		extensions: {},
		auth: { enabled: false },
	} as unknown as LeitwerkConfig;
}
