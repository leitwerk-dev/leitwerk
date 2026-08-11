export interface ExtensionLoadingConfigSnapshot {
	sources: string[];
}

export interface ServerWebsocketConfigSnapshot {
	heartbeat_interval: string;
	client_timeout: string;
	toast_ttl: string;
}

export interface ServerConfigSnapshot {
	host: string;
	port: number;
	base_url: string;
	websocket: ServerWebsocketConfigSnapshot;
}

export interface StorageConfigSnapshot {
	sqlite_path: string;
	process_workspaces_dir: string;
	tree_files_dir: string;
}

export interface ComponentConfigSnapshot {
	repo: string;
	default_branch: string;
	/**
	 * Worker runtime profile this component requires. Selection precedence is
	 * process override → component → default; conflicting component profiles on
	 * a single process are rejected before the worker starts.
	 */
	worker_runtime_profile?: string;
}

export interface WorkersCleanupConfigSnapshot {
	transient_ttl: string;
	completed_process_retention: string;
	error_process_retention: string;
}

export interface WorkersConfigSnapshot {
	/** Worker execution run mode. Docker/Kubernetes are production; local is test/development only. */
	runner: "docker" | "kubernetes" | "local";
	/**
	 * Fallback worker runtime profile id used when neither the process nor any
	 * component selects one. Must reference a configured `worker_runtime_profiles`
	 * entry when set.
	 */
	default_runtime_profile?: string;
	max_parallel_processes: number;
	startup_timeout: string;
	shutdown_grace_period: string;
	heartbeat_interval: string;
	turn_max_duration: string;
	turn_inactivity_timeout: string;
	turn_abort_grace_period: string;
	stale_heartbeat_timeout: string;
	resume_on_boot: boolean;
	idle_worker_ttl: string;
	/** Server-enforced maximum HTTP session snapshot upload size in bytes. */
	session_snapshot_max_size_bytes: number;
	/** Server-owned debug mirror for raw worker.event payloads. Workers ignore this switch. */
	log_worker_events_to_stdout: boolean;
	cleanup: WorkersCleanupConfigSnapshot;
}

export interface WorkerRuntimeConfigSnapshot {
	heartbeat_interval: string;
	turn_max_duration: string;
	turn_inactivity_timeout: string;
	turn_abort_grace_period: string;
}

export interface ModelProfileSnapshot {
	id: string;
	provider: string;
	model_id: string;
	thinking_level?: string;
	/** Non-secret provider-owned defaults applied to each new LLM start. */
	provider_options?: Record<string, string>;
}

export interface PiProviderRetryConfigSnapshot {
	/** Optional provider/SDK request timeout. Null defers to the provider SDK default. */
	timeout: string | null;
	/** Optional provider/SDK retry attempts. Null defers to the provider SDK default. */
	max_retries: number | null;
	/** Maximum provider-requested retry delay before failing fast. */
	max_retry_delay: string;
}

export interface PiRetryConfigSnapshot {
	enabled: boolean;
	max_retries: number;
	base_delay: string;
	provider: PiProviderRetryConfigSnapshot;
}

export interface PiProcessTitleGenerationRetryConfigSnapshot {
	/** Total title-generation attempts including the first immediate try. */
	max_attempts: number;
	/** Base outer retry delay after a failed server-side title request. */
	base_delay: string;
	/** Maximum outer retry delay for failed title-generation jobs. */
	max_delay: string;
}

export interface PiProcessTitleGenerationConfigSnapshot {
	model_profile: string | null;
	retry: PiProcessTitleGenerationRetryConfigSnapshot;
}

export interface PiConfigSnapshot {
	/** Leitwerk-managed Pi agent directory. Local workers use it as PI_CODING_AGENT_DIR. */
	agent_dir: string;
	model_profiles: ModelProfileSnapshot[];
	/** Global default system prompt template for all processes. Rendered with Mustache against runtime context. When omitted, the worker uses its built-in default. */
	system_prompt_template?: string;
	/** Server-side pre-start process title generation settings. */
	process_title_generation: PiProcessTitleGenerationConfigSnapshot;
	/** Leitwerk-managed Pi retry/runtime settings for newly created worker sessions. */
	retry: PiRetryConfigSnapshot;
}

export interface ProcessPiConfigSnapshot {
	system_prompt_template?: string;
	append_system_prompt_template?: string;
}

export interface ProcessTurnConfigSnapshot {
	model_profile?: string;
}

export interface ProcessConfigSnapshot {
	default_model_profile?: string;
	/**
	 * Restricts which model profiles this process may use.
	 * When set, only listed profile IDs are valid for default, turn, and override selections.
	 * When omitted, all configured model profiles are allowed.
	 */
	allowed_model_profiles?: string[];
	/**
	 * Process-level worker runtime profile override. Wins over per-component
	 * selection. Must reference a configured `worker_runtime_profiles` entry.
	 */
	worker_runtime_profile?: string;
	pi?: ProcessPiConfigSnapshot;
	turn_configs: Record<string, ProcessTurnConfigSnapshot>;
	/** Extension-owned watcher configuration, keyed by code-defined watcher id. */
	watchers?: Record<string, unknown>;
}

export interface WorkerProcessConfigSnapshot {
	pi?: ProcessPiConfigSnapshot;
}

export interface NotificationChannelConfigSnapshot {
	enabled: boolean;
	type: string;
	url: string;
}

export interface SquadNotificationRouteSnapshot {
	url: string;
}

export interface SquadNotificationConfigSnapshot {
	enabled: boolean;
	type: string;
	routing_field: string;
	routes: Record<string, SquadNotificationRouteSnapshot>;
}

export interface NotificationsConfigSnapshot {
	all: NotificationChannelConfigSnapshot;
	debug: NotificationChannelConfigSnapshot;
	squad: SquadNotificationConfigSnapshot;
}

export interface SandboxConfigSnapshot {
	enabled: boolean;
	profile: string;
}

/**
 * Worker-safe config object snapshot sent from server to worker at bootstrap
 * time. Server-only wiring and unused operator/server config are intentionally
 * excluded.
 */
export interface ConfigSnapshot {
	workers: WorkerRuntimeConfigSnapshot;
	pi: PiConfigSnapshot;
	process_configs?: Record<string, WorkerProcessConfigSnapshot>;
}
