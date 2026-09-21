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
} from "@leitwerk-dev/protocol/config-snapshot";
import type { DockerNetworkConfig } from "@leitwerk-dev/worker-protocol";

export type {
	ComponentConfigSnapshot as ComponentConfig,
	ConfigSnapshot,
	ExtensionLoadingConfigSnapshot as ExtensionLoadingConfig,
	ModelProfileSnapshot as ModelProfile,
	ProcessConfigSnapshot as ProcessConfig,
	SandboxConfigSnapshot as SandboxConfig,
	ServerConfigSnapshot as ServerConfig,
	StorageConfigSnapshot as StorageConfig,
	WorkersConfigSnapshot as WorkersConfig,
} from "@leitwerk-dev/protocol/config-snapshot";

/** @internal */
export interface SkillRepositoryConfig {
	/** @internal */
	id: string;
	/** @internal */
	label?: string;
	/** @internal */
	url: string;
	/** @internal */
	ref: string;
	/** Directory recursively scanned for skill directories. Defaults to `skills`. @internal */
	path?: string;
}

/** @internal */
export interface AuthSessionConfig {
	/** @internal */
	cookie_name?: string;
	/** @internal */
	ttl?: string;
}

/** @internal */
export interface AuthOidcProviderConfig {
	/** @internal */
	id: string;
	/** @internal */
	kind: "oidc";
	/** @internal */
	issuer: string;
	/** @internal */
	client_id: string;
	/** @internal */
	client_secret: string;
	/** @internal */
	redirect_uri?: string;
	/** @internal */
	scopes?: string[];
	/** @internal */
	identity_claim?: string;
}

/** @internal */
export interface AuthGithubProviderConfig {
	/** @internal */
	id: "github";
	/** @internal */
	kind: "oauth2";
	/** @internal */
	client_id: string;
	/** @internal */
	client_secret: string;
	/** GitHub organization whose active members may sign in. @internal */
	organization: string;
	/** @internal */
	redirect_uri?: string;
}

/** @internal */
export type AuthProviderConfig = AuthOidcProviderConfig | AuthGithubProviderConfig;

/** @internal */
export interface ApiTokensConfig {
	/** @internal */
	enabled?: boolean;
	/** @internal */
	default_ttl?: string;
	/** @internal */
	max_ttl?: string;
	/** @internal */
	allow_no_expiry?: boolean;
}

/** @internal */
export interface AuthConfig {
	/** @internal */
	api_tokens?: ApiTokensConfig;
	/** Only true enables authentication; omit or set false to keep the leitwerk unauthenticated. @internal */
	enabled?: boolean;
	/** @internal */
	session?: AuthSessionConfig;
	/** @internal */
	providers?: AuthProviderConfig[];
	/** Raw OIDC identity claim values that may sign in. GitHub uses organization membership. @internal */
	allowlist?: string[];
}

/** @internal */
export interface DockerProcessVolumeConfig {
	/** `bind` mounts a host path; `named_volume` uses a Docker-managed volume. @internal */
	mode: "bind" | "named_volume";
	/** Host root under which per-process volumes are created (bind mode). @internal */
	host_root: string;
	/** Path inside the worker container where the volume is mounted. @internal */
	mount_path: string;
}

/** @internal */
export interface DockerPrivateDaemonConfig {
	/** Exact isolation used for every Docker-requiring process. @internal */
	isolation: "privileged" | "sysbox-runc";
}

/**
 * Server-only Docker run-mode wiring. The worker never receives this block; it
 * dials back over WebSocket using launcher-injected connect env.
 */
/** @internal */
export interface DockerRunnerConfig {
	/** Docker Engine API socket (Podman/OrbStack/nerdctl compatible). @internal */
	socket: string;
	/** Shared private user-defined network for server + workers. @internal */
	network: string;
	/** Stable internal HTTP(S) base URL workers use for IPC, never a host IP. @internal */
	server_url: string;
	/** CA the worker trusts for internal TLS (self-signed ok on a private net). @internal */
	server_ca_file?: string;
	/** @internal */
	process_volume: DockerProcessVolumeConfig;
	/** Private daemon realization for Docker-requiring processes. @internal */
	private_daemon?: DockerPrivateDaemonConfig;
}

/** @internal */
export interface KubernetesProcessVolumeConfig {
	/** Optional ready-volume target; zero stops replenishment. @internal */
	pre_provision?: {
		/** @internal */
		count: number;
	};
	/** @internal */
	storage_class_name?: string;
	/** @internal */
	size: string;
	/** @internal */
	access_modes: string[];
	/** @internal */
	mount_path: string;
}

/** @internal */
export interface KubernetesDockerConfig {
	/** Pod RuntimeClass selected for every Docker-requiring process. @internal */
	runtime_class_name?: string;
	/** Pod user-namespace policy passed directly to spec.hostUsers. @internal */
	host_users?: boolean;
	/** @internal Opt in to the verified gVisor Docker wrapper and guest capabilities. */
	gvisor?: boolean;
	/** StorageClass selected for the process's single retained PVC. @internal */
	process_storage_class_name?: string;
	/** @internal */
	network?: DockerNetworkConfig;
}

/** @internal */
export interface KubernetesHostAliasConfig {
	/** @internal */
	ip: string;
	/** @internal */
	hostnames: string[];
}

/** @internal */
export interface KubernetesPodConfig {
	/** @internal */
	node_selector?: Record<string, string>;
	/** @internal */
	tolerations?: unknown[];
	/** @internal */
	annotations?: Record<string, string>;
	/** @internal */
	host_aliases?: KubernetesHostAliasConfig[];
}

/** @internal */
export interface KubernetesImagePullSecretCopyConfig {
	/** Secret name in the server namespace. @internal */
	source_name: string;
	/** Secret name created in each process namespace. @internal */
	target_name: string;
}

/** Server-only Kubernetes run-mode wiring. @public */
export interface LocalWorkerRunnerConfig {
	/** Command used by the best-effort local dev/test runner. @internal */
	command: string;
	/** Arguments passed to the local worker command. @internal */
	args: string[];
	/** Explicit acknowledgement that Docker processes inherit host Docker authority. @public */
	allow_host_docker?: boolean;
}

/** @internal */
export interface KubernetesRunnerConfig {
	/** Dedicated namespace where the singleton server runs. @internal */
	server_namespace: string;
	/** Safe DNS prefix used to derive one namespace per process instance. @internal */
	process_namespace_prefix: string;
	/** Stable in-cluster HTTP(S) base URL workers use to dial the server. @internal */
	server_url: string;
	/** Server-local CA bundle copied into process namespaces for worker TLS trust. @internal */
	server_ca_file?: string;
	/** Optional Kubernetes API URL override; defaults to the in-cluster service. @internal */
	api_server_url?: string;
	/** @internal */
	default_worker_runtime_profile?: string;
	/** @internal */
	worker_service_account?: string;
	/** @internal */
	process_volume: KubernetesProcessVolumeConfig;
	/** Trusted private-Docker realization. Incomplete blocks leave Docker processes unavailable. @internal */
	docker?: KubernetesDockerConfig;
	/** @internal */
	pod?: KubernetesPodConfig;
	/** @internal */
	image_pull_secrets?: string[];
	/** @internal */
	image_pull_secret_copies?: KubernetesImagePullSecretCopyConfig[];
}

/** @internal */
export interface WorkerRuntimeProfileCpuMemoryConfig {
	/** @internal */
	cpu?: string;
	/** @internal */
	memory?: string;
}

/** @internal */
export interface DockerRegistryConfig {
	/** Actual registry permissions are enforced by the registry, not this binding. @internal */
	profiles: Record<
		string,
		{
			/** @internal */
			registry: string;
			/** @internal */
			username: string;
			/** @internal */
			password: string;
		}
	>;
	/** @internal */
	process_bindings: Record<string, string[]>;
}

/** @internal */
export interface WorkerRuntimeProfileResourcesConfig {
	/** @internal */
	requests?: WorkerRuntimeProfileCpuMemoryConfig;
	/** @internal */
	limits?: WorkerRuntimeProfileCpuMemoryConfig;
	/** Back-compat shorthand interpreted as limits by Docker and manifest builders. @internal */
	cpu?: string;
	/** @internal */
	memory?: string;
}

/**
 * A reusable worker image selection authored only in leitwerk config.
 * Repository branch content must never select an image.
 */
/** @internal */
export interface WorkerRuntimeProfileConfig {
	/** Fully qualified image reference, ideally digest-pinned for production. @internal */
	image: string;
	/** @internal */
	image_pull_policy?: string;
	/** @internal */
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
/** @internal */
export interface CommitMessageTemplateConfig {
	/** Human-readable instructions applied to generated commit messages. @internal */
	rules: string;
}

/** @internal */
export interface CommitMessageConfig {
	/** Named, reusable formatting-rule templates. @internal */
	templates: Record<string, CommitMessageTemplateConfig>;
	/** Template used when a repository has no explicit mapping. Null/omitted uses built-in guidance. @internal */
	default_template?: string | null;
	/** Repository locator to template id. Locators are normalized before matching. @internal */
	repositories: Record<string, string>;
}

/** @internal */
export interface InternalTlsConfig {
	/** @internal */
	enabled: boolean;
	/** PEM cert chain the server presents on the internal listener. @internal */
	cert_file?: string;
	/** PEM private key for {@link InternalTlsConfig.cert_file}. @internal */
	key_file?: string;
	/**
	 * Reserved for future worker client-certificate verification. Currently
	 * rejected by validation because workers do not receive client cert/key material.
	 */
	/** @internal */
	client_ca_file?: string;
}

/** @internal */
export interface SessionTransferConfig {
	/** @internal */
	max_entries: number;
	/** @internal */
	max_logical_bytes: number;
	/** @internal */
	max_compressed_bytes: number;
}

/** @internal */
export interface DevelopmentToolsConfig {
	/** @internal */
	install_timeout: string;
	/** @internal */
	local: {
		/** @internal */
		mise_command: string;
	};
}

/** Server-owned config. `auth` and runner wiring are intentionally server-only and are not part of the worker ConfigSnapshot. @public */
export interface LeitwerkConfig extends ConfigSnapshot {
	/** @public */
	server: ServerConfigSnapshot;
	/** @public */
	storage: StorageConfigSnapshot;
	/** @internal */
	components: Record<string, ComponentConfigSnapshot>;
	/** @public */
	workers: WorkersConfigSnapshot;
	/** @internal */
	development_tools: DevelopmentToolsConfig;
	/** @public */
	process_configs?: Record<string, ProcessConfigSnapshot>;
	/** @internal */
	notifications: NotificationsConfigSnapshot;
	/** @internal */
	sandbox: SandboxConfigSnapshot;
	/** @public */
	extension_loading: ExtensionLoadingConfigSnapshot;
	/** Extension-owned config blocks, keyed by extension ID. @public */
	extensions: Record<string, unknown>;
	/** @internal */
	auth?: AuthConfig;
	/** Server-only Docker run-mode wiring; stripped from the worker snapshot. @internal */
	docker?: DockerRunnerConfig;
	/** Server-only credentials delivered exclusively through authenticated worker.start. @internal */
	docker_registries?: DockerRegistryConfig;
	/** Server-only Kubernetes run-mode wiring; stripped from the worker snapshot. @internal */
	kubernetes?: KubernetesRunnerConfig;
	/** Server-only best-effort local dev/test runner wiring; stripped from the worker snapshot. @public */
	local_worker?: LocalWorkerRunnerConfig;
	/** Reusable worker image selections; stripped from the worker snapshot. @internal */
	worker_runtime_profiles?: Record<string, WorkerRuntimeProfileConfig>;
	/** Server-only internal TLS for worker IPC; stripped from the worker snapshot. @internal */
	internal_tls?: InternalTlsConfig;
	/** Git repositories scanned for operator-managed skills. @internal */
	skill_repositories?: SkillRepositoryConfig[];
	/** Server-owned repository-aware commit-message generation rules. @internal */
	commit_messages?: CommitMessageConfig;
	/** Bounded archive and extraction ceilings for local session transfer. @internal */
	session_transfer?: SessionTransferConfig;
}
