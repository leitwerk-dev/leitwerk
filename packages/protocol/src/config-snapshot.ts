/** @public */
export interface ExtensionLoadingConfigSnapshot {
	/** @public */
	sources: string[];
}

/** @internal */
export interface ServerWebsocketConfigSnapshot {
	/** @internal */
	heartbeat_interval: string;
	/** @internal */
	client_timeout: string;
	/** @internal */
	toast_ttl: string;
}

/** @public */
export interface ServerConfigSnapshot {
	/** @public */
	host: string;
	/** @public */
	port: number;
	/** @public */
	base_url: string;
	/** @internal */
	websocket: ServerWebsocketConfigSnapshot;
}

/** @public */
export interface StorageConfigSnapshot {
	/** @public */
	sqlite_path: string;
	/** @public */
	process_workspaces_dir: string;
	/** @public */
	tree_files_dir: string;
}

/** @internal */
export interface ComponentConfigSnapshot {
	/** @internal */
	repo: string;
	/** @internal */
	default_branch: string;
	/**
	 * Worker runtime profile this component requires. Selection precedence is
	 * process override → component → default; conflicting component profiles on
	 * a single process are rejected before the worker starts.
	 */
	/** @internal */
	worker_runtime_profile?: string;
}

/** @internal */
export interface WorkersCleanupConfigSnapshot {
	/** @internal */
	transient_ttl: string;
	/** @internal */
	completed_process_retention: string;
	/** @internal */
	error_process_retention: string;
}

/** @public */
export interface WorkersConfigSnapshot {
	/** Worker execution run mode. Docker/Kubernetes are production; local is test/development only. @public */
	runner: "docker" | "kubernetes" | "local";
	/**
	 * Fallback worker runtime profile id used when neither the process nor any
	 * component selects one. Must reference a configured `worker_runtime_profiles`
	 * entry when set.
	 */
	/** @internal */
	default_runtime_profile?: string;
	/** @internal */
	max_parallel_processes: number;
	/** @internal */
	startup_timeout: string;
	/** @public */
	shutdown_grace_period: string;
	/** @internal */
	heartbeat_interval: string;
	/** @internal */
	turn_max_duration: string;
	/** @internal */
	turn_inactivity_timeout: string;
	/** @internal */
	turn_abort_grace_period: string;
	/** @internal */
	stale_heartbeat_timeout: string;
	/** @internal */
	resume_on_boot: boolean;
	/** @internal */
	idle_worker_ttl: string;
	/** Server-enforced maximum HTTP session snapshot upload size in bytes. @internal */
	session_snapshot_max_size_bytes: number;
	/** Server-owned debug mirror for raw worker.event payloads. Workers ignore this switch. @internal */
	log_worker_events_to_stdout: boolean;
	/** @internal */
	cleanup: WorkersCleanupConfigSnapshot;
}

/** @internal */
export interface WorkerRuntimeConfigSnapshot {
	/** @internal */
	heartbeat_interval: string;
	/** @internal */
	turn_max_duration: string;
	/** @internal */
	turn_inactivity_timeout: string;
	/** @internal */
	turn_abort_grace_period: string;
}

/** @public */
export interface ModelProfileSnapshot {
	/** @public */
	id: string;
	/** @public */
	provider: string;
	/** @public */
	model_id: string;
	/** @public */
	thinking_level?: string;
	/** Non-secret provider-owned defaults applied to each new LLM start. @internal */
	provider_options?: Record<string, string>;
}

/** @internal */
export interface PiProviderRetryConfigSnapshot {
	/** Optional provider/SDK request timeout. Null defers to the provider SDK default. @internal */
	timeout: string | null;
	/** Optional provider/SDK retry attempts. Null defers to the provider SDK default. @internal */
	max_retries: number | null;
	/** Maximum provider-requested retry delay before failing fast. @internal */
	max_retry_delay: string;
}

/** @internal */
export interface PiRetryConfigSnapshot {
	/** @internal */
	enabled: boolean;
	/** @internal */
	max_retries: number;
	/** @internal */
	base_delay: string;
	/** @internal */
	provider: PiProviderRetryConfigSnapshot;
}

/** @internal */
export interface PiProcessTitleGenerationRetryConfigSnapshot {
	/** Total title-generation attempts including the first immediate try. @internal */
	max_attempts: number;
	/** Base outer retry delay after a failed server-side title request. @internal */
	base_delay: string;
	/** Maximum outer retry delay for failed title-generation jobs. @internal */
	max_delay: string;
}

/** @public */
export interface PiProcessTitleGenerationConfigSnapshot {
	/** @public */
	model_profile: string | null;
	/** @internal */
	retry: PiProcessTitleGenerationRetryConfigSnapshot;
}

/** @public */
export interface PiConfigSnapshot {
	/** Leitwerk-managed Pi agent directory. Local workers use it as PI_CODING_AGENT_DIR. @public */
	agent_dir: string;
	/** @public */
	model_profiles: ModelProfileSnapshot[];
	/** Global default system prompt template for all processes. Rendered with Mustache against runtime context. When omitted, the worker uses its built-in default. @internal */
	system_prompt_template?: string;
	/** Server-side pre-start process title generation settings. @public */
	process_title_generation: PiProcessTitleGenerationConfigSnapshot;
	/** Leitwerk-managed Pi retry/runtime settings for newly created worker sessions. @internal */
	retry: PiRetryConfigSnapshot;
}

/** @internal */
export interface ProcessPiConfigSnapshot {
	/** @internal */
	system_prompt_template?: string;
	/** @internal */
	append_system_prompt_template?: string;
}

/** @public */
export interface ProcessTurnConfigSnapshot {
	/** @internal */
	model_profile?: string;
}

/** @public */
export interface ProcessConfigSnapshot {
	/** @public */
	default_model_profile?: string;
	/**
	 * Restricts which model profiles this process may use.
	 * When set, only listed profile IDs are valid for default, turn, and override selections.
	 * When omitted, all configured model profiles are allowed.
	 */
	/** @internal */
	allowed_model_profiles?: string[];
	/**
	 * Process-level worker runtime profile override. Wins over per-component
	 * selection. Must reference a configured `worker_runtime_profiles` entry.
	 */
	/** @internal */
	worker_runtime_profile?: string;
	/** Server-only process-volume capacity override, for example 128Mi or 1Gi. @internal */
	storage_size?: string;
	/** @internal */
	pi?: ProcessPiConfigSnapshot;
	/** @public */
	turn_configs: Record<string, ProcessTurnConfigSnapshot>;
	/** Extension-owned watcher configuration, keyed by code-defined watcher id. @public */
	watchers?: Record<string, unknown>;
}

/** @internal */
export interface WorkerProcessConfigSnapshot {
	/** @internal */
	pi?: ProcessPiConfigSnapshot;
}

/** @internal */
export interface NotificationChannelConfigSnapshot {
	/** @internal */
	enabled: boolean;
	/** @internal */
	type: string;
	/** @internal */
	url: string;
}

/** @internal */
export interface SquadNotificationRouteSnapshot {
	/** @internal */
	url: string;
}

/** @internal */
export interface SquadNotificationConfigSnapshot {
	/** @internal */
	enabled: boolean;
	/** @internal */
	type: string;
	/** @internal */
	routing_field: string;
	/** @internal */
	routes: Record<string, SquadNotificationRouteSnapshot>;
}

/** @internal */
export interface NotificationsConfigSnapshot {
	/** @internal */
	all: NotificationChannelConfigSnapshot;
	/** @internal */
	debug: NotificationChannelConfigSnapshot;
	/** @internal */
	squad: SquadNotificationConfigSnapshot;
}

/** @internal */
export interface SandboxConfigSnapshot {
	/** @internal */
	enabled: boolean;
	/** @internal */
	profile: string;
}

/**
 * Worker-safe config object snapshot sent from server to worker at bootstrap
 * time. Server-only wiring and unused operator/server config are intentionally
 * excluded.
 */
/** @public */
export interface ConfigSnapshot {
	/** @internal */
	workers: WorkerRuntimeConfigSnapshot;
	/** @public */
	pi: PiConfigSnapshot;
	/** @internal */
	process_configs?: Record<string, WorkerProcessConfigSnapshot>;
}
