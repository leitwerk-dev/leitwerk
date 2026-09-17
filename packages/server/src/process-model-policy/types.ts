import type {
	DurableModelSelection,
	LaunchModelConfigInput,
	ModelSelectionKind,
	ProcessInstance,
	ProcessSelectedTurnModelSource,
	TurnStartKind,
	TurnStartRecord,
} from "@leitwerk-dev/domain";
import type { LaunchPlanPreparationResultLike, ProcessLaunchPlan } from "@leitwerk-dev/process-sdk";
import type { ModelStatusCacheSnapshot } from "../model-providers/model-status-cache.js";

/** @internal */
export type ProcessModelAvailabilitySnapshot = ModelStatusCacheSnapshot;

/** @internal */
export type PersistedModelConfigurationIssue = {
	/** @internal */
	readonly code: "invalid_turn_configs_json";
	/** @internal */
	readonly reason: "invalid_json" | "not_object" | "turn_config_not_object";
	/** @internal */
	readonly turnId?: string;
};

export interface ValidModelConfiguration {
	readonly kind: "valid";
	readonly processId: string;
	readonly defaultProfileId?: string;
	readonly turnProfileIds: ReadonlyMap<string, string>;
}

export interface InvalidModelConfiguration {
	readonly kind: "invalid";
	readonly processId: string;
	readonly issues: readonly PersistedModelConfigurationIssue[];
}

export type ModelConfiguration = ValidModelConfiguration | InvalidModelConfiguration;

/** @internal */
export type PersistedModelRelationalIssue =
	| {
			/** @internal */
			readonly code: "model_config_requires_llm_turn";
			/** @internal */
			readonly turnId: string;
	  }
	| {
			/** @internal */
			readonly code: "selected_model_requires_selected_turn";
			/** @internal */
			readonly modelProfileId: string;
	  }
	| {
			/** @internal */
			readonly code: "selected_model_requires_llm_turn";
			/** @internal */
			readonly turnId: string;
			/** @internal */
			readonly modelProfileId: string;
	  };

/** @internal */
export type PersistedModelSelectionIssue = {
	/** @internal */
	readonly code: "contradictory_provenance";
	/** @internal */
	readonly turnId: string;
	/** @internal */
	readonly modelProfileId: string;
	/** @internal */
	readonly kind: ModelSelectionKind;
	/** @internal */
	readonly source: ProcessSelectedTurnModelSource;
};

/** @internal */
export type PersistedModelIntegrityIssue =
	| PersistedModelConfigurationIssue
	| PersistedModelRelationalIssue
	| PersistedModelSelectionIssue;

/** @internal */
export type PersistedModelIntegrity =
	| {
			/** @internal */
			readonly kind: "valid";
	  }
	| {
			/** @internal */
			readonly kind: "malformed";
			/** @internal */
			readonly issues: readonly PersistedModelIntegrityIssue[];
	  };

export type ExistingTurnSelection =
	| { readonly kind: "none" }
	| {
			readonly kind: "selected";
			readonly turnId: string;
			readonly selection: DurableModelSelection;
	  }
	| {
			readonly kind: "invalid";
			readonly turnId: string;
			readonly issues: readonly PersistedModelSelectionIssue[];
	  };

export type ModelOverride =
	| { readonly kind: "inherit" }
	| { readonly kind: "clear" }
	| {
			readonly kind: "profile";
			readonly profileId: string;
			readonly source: Extract<
				ProcessSelectedTurnModelSource,
				"action_override" | "launch_override"
			>;
	  };

/** @internal */
type ProcessModelPolicyFailureBase = {
	/** @internal */
	readonly ok: false;
	/** @internal */
	readonly selection: DurableModelSelection | null;
	/** @internal */
	readonly availabilityRevision?: number;
};

/** @internal */
export type ProcessModelPolicyFailure = ProcessModelPolicyFailureBase &
	(
		| {
				/** @internal */
				readonly code: "model_required";
		  }
		| {
				/** @internal */
				readonly code: "unknown_model_profile";
				/** @internal */
				readonly modelProfileId: string;
		  }
		| {
				/** @internal */
				readonly code: "model_profile_not_allowed";
				/** @internal */
				readonly modelProfileId: string;
				/** @internal */
				readonly processId: string;
		  }
		| {
				/** @internal */
				readonly code: "model_unavailable" | "model_stale";
				/** @internal */
				readonly reason: string | null;
		  }
		| {
				/** @internal */
				readonly code: "invalid_model_configuration";
				/** @internal */
				readonly source: "configuration" | "selection_provenance";
				/** @internal */
				readonly issues: readonly (
					| PersistedModelConfigurationIssue
					| PersistedModelSelectionIssue
				)[];
		  }
		| {
				/** @internal */
				readonly code: "stale_evaluation_snapshot";
		  }
	);
/** @internal */
export interface ProcessModelPolicyResolution {
	/** @internal */
	readonly ok: true;
	/** @internal */
	readonly selection: DurableModelSelection | null;
	/** @internal */
	readonly availabilityRevision?: number;
}
/** @internal */
export type ProcessModelPolicyEvaluation = ProcessModelPolicyResolution | ProcessModelPolicyFailure;

/** @internal */
export interface ProjectedModelProfile {
	/** @internal */
	readonly id: string;
	/** @internal */
	readonly providerId: string;
	/** @internal */
	readonly modelId: string;
	/** @internal */
	readonly thinkingLevel: string;
	/** @internal */
	readonly availability: "available" | "unavailable" | "stale";
	/** @internal */
	readonly safeReason: string | null;
	/** @internal */
	readonly checkedAt: string | null;
}

/** @internal */
export interface ProjectedModelDefault {
	/** @internal */
	readonly processConfigModelProfileId: string | null;
	/** @internal */
	readonly instanceModelProfileId: string | null;
	/** @internal */
	readonly effectiveModelProfileId: string | null;
	/** @internal */
	readonly source: "instance" | "process_config" | "catalog_default" | "none";
}

/** @internal */
export type ProjectedModelResolutionSource = ProcessSelectedTurnModelSource | "none";

/** @internal */
export interface ProjectedLauncherModelSchema {
	/** @internal */
	readonly profiles: readonly ProjectedModelProfile[];
	/** @internal */
	readonly turns: readonly {
		/** @internal */
		readonly turnId: string;
		/** @internal */
		readonly description: string;
	}[];
}

/** @internal */
export interface ProjectedLauncherModelPreview {
	/** @internal */
	readonly defaultModel: {
		/** @internal */
		readonly source: ProjectedModelDefault["source"];
		/** @internal */
		readonly profile: ProjectedModelProfile | null;
	};
	/** @internal */
	readonly turns: readonly {
		/** @internal */
		readonly turnId: string;
		/** @internal */
		readonly description: string;
		/** @internal */
		readonly effective: {
			/** @internal */
			readonly source: ProjectedModelResolutionSource;
			/** @internal */
			readonly profile: ProjectedModelProfile | null;
		};
	}[];
}

/** @internal */
export type ProjectedProcessModelConfiguration = {
	/** @internal */
	readonly state:
		| {
				/** @internal */
				readonly kind: "ready";
		  }
		| {
				/** @internal */
				readonly kind: "blocked";
				/** @internal */
				readonly issues: readonly PersistedModelConfigurationIssue[];
		  };
	/** @internal */
	readonly profiles: readonly ProjectedModelProfile[];
	/** @internal */
	readonly effectiveSelectedTurn: {
		/** @internal */
		readonly turnId: string;
		/** @internal */
		readonly description: string;
		/** @internal */
		readonly modelProfileId: string;
		/** @internal */
		readonly source: ProcessSelectedTurnModelSource;
	} | null;
	/** @internal */
	readonly defaultModel: ProjectedModelDefault;
	/** @internal */
	readonly turns: readonly {
		/** @internal */
		readonly turnId: string;
		/** @internal */
		readonly description: string;
		/** @internal */
		readonly pathType: string;
		/** @internal */
		readonly processConfigModelProfileId: string | null;
		/** @internal */
		readonly instanceModelProfileId: string | null;
		/** @internal */
		readonly effectiveConfiguredModelProfileId: string | null;
		/** @internal */
		readonly source: "instance" | "process_config" | "default";
	}[];
};

/** @internal */
export interface ProcessModelPolicyProjectionByKind {
	/** @internal */
	readonly profile_options: readonly ProjectedModelProfile[];
	/** @internal */
	readonly compatible_profiles: readonly string[];
	/** @internal */
	readonly launcher_schema: ProjectedLauncherModelSchema;
	/** @internal */
	readonly launcher_preview: ProjectedLauncherModelPreview;
	/** @internal */
	readonly process_configuration: ProjectedProcessModelConfiguration;
}

/** @internal */
export type ProcessModelPolicyEvaluationSubject =
	| {
			/** @internal */
			readonly kind: "process_turn";
			/** @internal */
			readonly process: ProcessInstance;
			/** @internal */
			readonly turnId: string;
			/** @internal */
			readonly availability?: ProcessModelAvailabilitySnapshot;
			/** @internal */
			readonly startKind?: TurnStartKind;
			/** True only when selecting the first turn of a persisted process. */
			/** @internal */
			readonly initialSelection?: boolean;
			/** @internal */
			readonly modelOverride?: string | null;
	  }
	| {
			/** @internal */
			readonly kind: "launch_plan_turn";
			/** @internal */
			readonly plan: ProcessLaunchPlan;
			/** @internal */
			readonly turnId: string;
			/** @internal */
			readonly availability: ProcessModelAvailabilitySnapshot;
	  }
	| {
			/** @internal */
			readonly kind: "runtime_selection";
			/** @internal */
			readonly processId: string;
			/** @internal */
			readonly selection: DurableModelSelection | null;
			/** @internal */
			readonly availability: ProcessModelAvailabilitySnapshot;
	  }
	| {
			/** @internal */
			readonly kind: "preparation_recovery";
			/** @internal */
			readonly cause: "availability_transition" | "startup_reconciliation";
			/** @internal */
			readonly process: ProcessInstance;
			/** @internal */
			readonly currentStart: TurnStartRecord;
			/** @internal */
			readonly availability: ProcessModelAvailabilitySnapshot;
	  };

/** @internal */
export type ProcessModelPolicyProjectionSubject =
	| {
			/** @internal */
			readonly kind: "profile_options";
			/** @internal */
			readonly processId: string;
			/** @internal */
			readonly availability: ProcessModelAvailabilitySnapshot;
	  }
	| {
			/** @internal */
			readonly kind: "compatible_profiles";
			/** @internal */
			readonly processId: string;
			/** @internal */
			readonly providerId: string;
			/** @internal */
			readonly modelId: string;
			/** @internal */
			readonly availability: ProcessModelAvailabilitySnapshot;
	  }
	| {
			/** @internal */
			readonly kind: "launcher_schema";
			/** @internal */
			readonly processId: string;
			/** @internal */
			readonly availability?: ProcessModelAvailabilitySnapshot;
	  }
	| {
			/** @internal */
			readonly kind: "launcher_preview";
			/** @internal */
			readonly processId: string;
			/** @internal */
			readonly modelConfig: LaunchModelConfigInput;
			/** @internal */
			readonly availability: ProcessModelAvailabilitySnapshot;
	  }
	| {
			/** @internal */
			readonly kind: "process_configuration";
			/** @internal */
			readonly process: ProcessInstance;
			/** @internal */
			readonly availability: ProcessModelAvailabilitySnapshot;
	  };

/** @internal */
export type ProcessModelPolicyProjectionKind = ProcessModelPolicyProjectionSubject["kind"];
/** @internal */
export type ProcessModelPolicyProjectionSubjectFor<K extends ProcessModelPolicyProjectionKind> =
	Extract<
		ProcessModelPolicyProjectionSubject,
		{
			/** @internal */
			readonly kind: K;
		}
	>;

/** @internal */
export interface ProcessModelPolicyFingerprintSubject {
	/** @internal */
	readonly process: ProcessInstance;
	/** @internal */
	readonly currentStart: TurnStartRecord;
}

/** @internal */
export interface PrepareLaunchPlanOptions {
	/** @internal */
	readonly modelConfig?: LaunchModelConfigInput;
	/** @internal */
	readonly replaceModelConfig?: boolean;
	/** @internal */
	readonly invalidModelConfig?: "reject" | "omit";
}

/** @internal */
export interface ServerProcessModelPolicy {
	/** @internal */
	prepareLaunchPlan(
		launchPlan: ProcessLaunchPlan,
		opts?: PrepareLaunchPlanOptions,
	): LaunchPlanPreparationResultLike;
	/** @internal */
	inspectPersistedState(process: ProcessInstance): PersistedModelIntegrity;
	/** @internal */
	evaluate(request: ProcessModelPolicyEvaluationSubject): ProcessModelPolicyEvaluation;
	/** @internal */
	project<K extends ProcessModelPolicyProjectionKind>(
		request: ProcessModelPolicyProjectionSubjectFor<K>,
	): ProcessModelPolicyProjectionByKind[K];
	/** @internal */
	fingerprint(request: ProcessModelPolicyFingerprintSubject): string;
}
export interface PolicyProfile {
	readonly id: string;
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: string;
	readonly providerOptions: Readonly<Record<string, unknown>>;
}
export interface PolicyProcess {
	readonly id: string;
	readonly allowedProfileIds: ReadonlySet<string> | null;
	readonly defaultProfileId: string | null;
	readonly turnProfileIds: Readonly<Record<string, string | null>>;
	readonly llmTurnIds: ReadonlySet<string>;
	readonly purposeProfileIdsByTurn: Readonly<Record<string, string>>;
	readonly turnDescriptions: Readonly<Record<string, string>>;
	readonly turnPathTypes: Readonly<Record<string, string>>;
}
export interface PolicySnapshot {
	readonly profiles: readonly PolicyProfile[];
	readonly profilesById: ReadonlyMap<string, PolicyProfile>;
	readonly processesById: ReadonlyMap<string, PolicyProcess>;
	readonly workerStaticConfig: unknown;
}
export function provenanceKindForSource(
	source: import("@leitwerk-dev/domain").ProcessSelectedTurnModelSource | null | undefined,
): import("@leitwerk-dev/domain").ModelSelectionProvenance["kind"] {
	return source === "action_override" ||
		source === "launch_override" ||
		source === "instance_turn_config" ||
		source === "instance_default"
		? "explicit"
		: "inherited";
}
