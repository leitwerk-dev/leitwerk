import type {
	ComponentConfigSnapshot,
	ConfigSnapshot,
	ExtensionLoadingConfigSnapshot,
	NotificationsConfigSnapshot,
	ProcessConfigSnapshot,
	SandboxConfigSnapshot,
	ServerConfigSnapshot,
	StorageConfigSnapshot,
	WorkersConfigSnapshot,
} from "@leitwerk-dev/protocol";

export type {
	ComponentConfigSnapshot as ComponentConfig,
	ConfigSnapshot,
	ExtensionLoadingConfigSnapshot as ExtensionLoadingConfig,
	ModelProfileSnapshot as ModelProfile,
	NotificationChannelConfigSnapshot as NotificationChannelConfig,
	NotificationsConfigSnapshot as NotificationsConfig,
	PiConfigSnapshot as PiConfig,
	PiProcessTitleGenerationConfigSnapshot,
	PiProcessTitleGenerationRetryConfigSnapshot,
	PiProviderRetryConfigSnapshot,
	PiRetryConfigSnapshot,
	ProcessConfigSnapshot as ProcessConfig,
	ProcessTurnConfigSnapshot as ProcessTurnConfig,
	SandboxConfigSnapshot as SandboxConfig,
	ServerConfigSnapshot as ServerConfig,
	ServerWebsocketConfigSnapshot,
	SquadNotificationConfigSnapshot as SquadNotificationConfig,
	SquadNotificationRouteSnapshot,
	StorageConfigSnapshot as StorageConfig,
	WorkersCleanupConfigSnapshot,
	WorkersConfigSnapshot as WorkersConfig,
} from "@leitwerk-dev/protocol";

export interface SkillRepositoryConfig {
	id: string;
	label?: string;
	url: string;
	ref: string;
	/** Directory recursively scanned for skill directories. Defaults to `skills`. */
	path?: string;
}

export interface AuthSessionConfig {
	cookie_name?: string;
	ttl?: string;
}

export interface AuthOidcProviderConfig {
	id: string;
	kind: "oidc";
	issuer: string;
	client_id: string;
	client_secret: string;
	redirect_uri?: string;
	scopes?: string[];
	identity_claim?: string;
}

export interface AuthGithubProviderConfig {
	id: "github";
	kind: "oauth2";
	client_id: string;
	client_secret: string;
	/** GitHub organization whose active members may sign in. */
	organization: string;
	redirect_uri?: string;
}

export type AuthProviderConfig = AuthOidcProviderConfig | AuthGithubProviderConfig;

export interface ApiTokensConfig {
	enabled?: boolean;
	default_ttl?: string;
	max_ttl?: string;
	allow_no_expiry?: boolean;
}

export interface AuthConfig {
	api_tokens?: ApiTokensConfig;
	/** Only true enables authentication; omit or set false to keep the leitwerk unauthenticated. */
	enabled?: boolean;
	session?: AuthSessionConfig;
	providers?: AuthProviderConfig[];
	/** Raw OIDC identity claim values that may sign in. GitHub uses organization membership. */
	allowlist?: string[];
}

export interface DockerProcessVolumeConfig {
	/** `bind` mounts a host path; `named_volume` uses a Docker-managed volume. */
	mode: "bind" | "named_volume";
	/** Host root under which per-process volumes are created (bind mode). */
	host_root: string;
	/** Path inside the worker container where the volume is mounted. */
	mount_path: string;
}

export interface DockerPrivateDaemonConfig {
	/** Exact isolation used for every Docker-requiring process. */
	isolation: "privileged" | "sysbox-runc";
}

/**
 * Server-only Docker run-mode wiring. The worker never receives this block; it
 * dials back over WebSocket using launcher-injected connect env.
 */
export interface DockerRunnerConfig {
	/** Docker Engine API socket (Podman/OrbStack/nerdctl compatible). */
	socket: string;
	/** Shared private user-defined network for server + workers. */
	network: string;
	/** Stable internal HTTP(S) base URL workers use for IPC, never a host IP. */
	server_url: string;
	/** CA the worker trusts for internal TLS (self-signed ok on a private net). */
	server_ca_file?: string;
	process_volume: DockerProcessVolumeConfig;
	/** Private daemon realization for Docker-requiring processes. */
	private_daemon?: DockerPrivateDaemonConfig;
}

export interface KubernetesProcessVolumeConfig {
	/** Optional ready-volume target; zero stops replenishment. */
	pre_provision?: { count: number };
	storage_class_name?: string;
	size: string;
	access_modes: string[];
	mount_path: string;
}

export interface KubernetesDockerConfig {
	/** Pod RuntimeClass selected for every Docker-requiring process. */
	runtime_class_name?: string;
	/** Pod user-namespace policy passed directly to spec.hostUsers. */
	host_users?: boolean;
	/** StorageClass selected for the process's single retained PVC. */
	process_storage_class_name?: string;
}

export interface KubernetesHostAliasConfig {
	ip: string;
	hostnames: string[];
}

export interface KubernetesPodConfig {
	node_selector?: Record<string, string>;
	tolerations?: unknown[];
	annotations?: Record<string, string>;
	host_aliases?: KubernetesHostAliasConfig[];
}

export interface KubernetesImagePullSecretCopyConfig {
	/** Secret name in the server namespace. */
	source_name: string;
	/** Secret name created in each process namespace. */
	target_name: string;
}

/** Server-only Kubernetes run-mode wiring. */
export interface LocalWorkerRunnerConfig {
	/** Command used by the best-effort local dev/test runner. */
	command: string;
	/** Arguments passed to the local worker command. */
	args: string[];
	/** Explicit acknowledgement that Docker processes inherit host Docker authority. */
	allow_host_docker?: boolean;
}

export interface KubernetesRunnerConfig {
	/** Dedicated namespace where the singleton server runs. */
	server_namespace: string;
	/** Safe DNS prefix used to derive one namespace per process instance. */
	process_namespace_prefix: string;
	/** Stable in-cluster HTTP(S) base URL workers use to dial the server. */
	server_url: string;
	/** Server-local CA bundle copied into process namespaces for worker TLS trust. */
	server_ca_file?: string;
	/** Optional Kubernetes API URL override; defaults to the in-cluster service. */
	api_server_url?: string;
	default_worker_runtime_profile?: string;
	worker_service_account?: string;
	process_volume: KubernetesProcessVolumeConfig;
	/** Trusted private-Docker realization. Incomplete blocks leave Docker processes unavailable. */
	docker?: KubernetesDockerConfig;
	pod?: KubernetesPodConfig;
	image_pull_secrets?: string[];
	image_pull_secret_copies?: KubernetesImagePullSecretCopyConfig[];
}

export interface WorkerRuntimeProfileCpuMemoryConfig {
	cpu?: string;
	memory?: string;
}

export interface WorkerRuntimeProfileResourcesConfig {
	limits?: WorkerRuntimeProfileCpuMemoryConfig;
	/** Back-compat shorthand interpreted as limits by Docker and manifest builders. */
	cpu?: string;
	memory?: string;
}

/**
 * A reusable worker image selection authored only in leitwerk config.
 * Repository branch content must never select an image.
 */
export interface WorkerRuntimeProfileConfig {
	/** Fully qualified image reference, ideally digest-pinned for production. */
	image: string;
	image_pull_policy?: string;
	resources?: WorkerRuntimeProfileResourcesConfig;
}

/**
 * Server-only internal TLS for worker → server IPC. The server presents a cert
 * with a SAN for the stable internal name; workers trust the signing CA handed
 * to them via {@link DockerRunnerConfig.server_ca_file} or
 * {@link KubernetesRunnerConfig.server_ca_file}. Public UI/API HTTPS is
 * terminated separately by a reverse proxy. Disabled by default so local and
 * parity runs stay on plain HTTP.
 */
export interface CommitMessageTemplateConfig {
	/** Human-readable instructions applied to generated commit messages. */
	rules: string;
}

export interface CommitMessageConfig {
	/** Named, reusable formatting-rule templates. */
	templates: Record<string, CommitMessageTemplateConfig>;
	/** Template used when a repository has no explicit mapping. Null/omitted uses built-in guidance. */
	default_template?: string | null;
	/** Repository locator to template id. Locators are normalized before matching. */
	repositories: Record<string, string>;
}

export interface InternalTlsConfig {
	enabled: boolean;
	/** PEM cert chain the server presents on the internal listener. */
	cert_file?: string;
	/** PEM private key for {@link InternalTlsConfig.cert_file}. */
	key_file?: string;
	/**
	 * Reserved for future worker client-certificate verification. Currently
	 * rejected by validation because workers do not receive client cert/key material.
	 */
	client_ca_file?: string;
}

export interface SessionTransferConfig {
	max_entries: number;
	max_logical_bytes: number;
	max_compressed_bytes: number;
}

export interface DevelopmentToolsConfig {
	install_timeout: string;
	local: { mise_command: string };
}

/** Server-owned config. `auth` and runner wiring are intentionally server-only and are not part of the worker ConfigSnapshot. */
export interface LeitwerkConfig extends ConfigSnapshot {
	server: ServerConfigSnapshot;
	storage: StorageConfigSnapshot;
	components: Record<string, ComponentConfigSnapshot>;
	workers: WorkersConfigSnapshot;
	development_tools: DevelopmentToolsConfig;
	process_configs?: Record<string, ProcessConfigSnapshot>;
	notifications: NotificationsConfigSnapshot;
	sandbox: SandboxConfigSnapshot;
	extension_loading: ExtensionLoadingConfigSnapshot;
	/** Extension-owned config blocks, keyed by extension ID. */
	extensions: Record<string, unknown>;
	auth?: AuthConfig;
	/** Server-only Docker run-mode wiring; stripped from the worker snapshot. */
	docker?: DockerRunnerConfig;
	/** Server-only Kubernetes run-mode wiring; stripped from the worker snapshot. */
	kubernetes?: KubernetesRunnerConfig;
	/** Server-only best-effort local dev/test runner wiring; stripped from the worker snapshot. */
	local_worker?: LocalWorkerRunnerConfig;
	/** Reusable worker image selections; stripped from the worker snapshot. */
	worker_runtime_profiles?: Record<string, WorkerRuntimeProfileConfig>;
	/** Server-only internal TLS for worker IPC; stripped from the worker snapshot. */
	internal_tls?: InternalTlsConfig;
	/** Git repositories scanned for operator-managed skills. */
	skill_repositories?: SkillRepositoryConfig[];
	/** Server-owned repository-aware commit-message generation rules. */
	commit_messages?: CommitMessageConfig;
	/** Bounded archive and extraction ceilings for local session transfer. */
	session_transfer?: SessionTransferConfig;
}
