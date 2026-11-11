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
import type {
	LauncherModelConfigSchema,
	ProcessModelConfigurationView,
} from "@leitwerk-dev/protocol/http-contracts";
import type { ModelStatusCacheSnapshot } from "../model-providers/model-status-cache.js";

/** @internal */
export type ProcessModelAvailabilitySnapshot = ModelStatusCacheSnapshot;

/** @internal */
export type PersistedModelConfigurationIssue = Readonly<
	Extract<ProcessModelConfigurationView["state"], { kind: "blocked" }>["issues"][number]
>;

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
	readonly ranking?: ModelRankingEvidence;
	/** @internal */
	readonly skippedPreferences?: readonly SkippedModelPreference[];
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
				/** Effective hard constraints when no eligible model exists. @internal */
				readonly requirements?: readonly PolicyRequirementLayer[];
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
				/** @internal */
				readonly rejections?: readonly ModelRequirementRejection[];
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
				readonly message?: string;
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
	readonly ranking?: ModelRankingEvidence;
	/** @internal */
	readonly skippedPreferences?: readonly SkippedModelPreference[];
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
	/** Independent of cached availability. @internal */
	readonly policyReason?: string;
	/** @internal */
	readonly id: string;
	/** @internal */
	readonly providerId: string;
	/** @internal */
	readonly modelId: string;
	/** @internal */
	readonly thinkingLevel: string;
	/** @internal */
	readonly labels?: readonly string[];
	/** @internal */
	readonly default?: boolean;
	/** @internal */
	readonly availability: "available" | "unavailable" | "stale";
	/** @internal */
	readonly safeReason: string | null;
	/** @internal */
	readonly checkedAt: string | null;
}

/** @internal */
export type ProjectedModelDefault = Readonly<ProcessModelConfigurationView["defaultModel"]>;

/** @internal */
export type ProjectedModelResolutionSource = ProcessSelectedTurnModelSource | "none";

/** @internal */
export interface ProjectedLauncherModelSchema {
	/** Excluded candidates with policy origins, keyed by turn; empty key denotes the process preference. @internal */
	readonly excludedProfiles?: Readonly<Record<string, readonly ProjectedModelProfile[]>>;
	/** @internal */
	readonly profilesByTurn?: Readonly<Record<string, readonly ProjectedModelProfile[]>>;
	/** @internal */
	readonly profiles: readonly ProjectedModelProfile[];
	/** @internal */
	readonly turns: LauncherModelConfigSchema["llmTurns"];
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
			readonly explanation?: string;
			/** @internal */
			readonly ranking?: ModelRankingEvidence;
			/** @internal */
			readonly error?: string;
			/** @internal */
			readonly source: ProjectedModelResolutionSource;
			/** @internal */
			readonly profile: ProjectedModelProfile | null;
		};
	}[];
}

/** @internal */
type ProjectedTurnModelConfiguration = Readonly<ProcessModelConfigurationView["turns"][number]>;

/** @internal */
export type ProjectedProcessModelConfiguration = Readonly<
	Omit<
		ProcessModelConfigurationView,
		"availableProfiles" | "profilesByTurn" | "excludedProfiles" | "turns"
	>
> &
	Pick<ProjectedLauncherModelSchema, "profiles" | "profilesByTurn" | "excludedProfiles"> & {
		/** @internal */
		readonly turns: readonly Readonly<
			ProjectedTurnModelConfiguration &
				Required<
					Pick<
						ProjectedTurnModelConfiguration,
						"fixedModelProfileId" | "effectiveModelProfileId" | "effectiveSource"
					>
				>
		>[];
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
			/** True only when selecting the first turn of a persisted process. @internal */
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
			/** Explicit validation scope. @internal */
			readonly target: ModelPolicyTarget;
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
			readonly target: ModelPolicyTarget;
			/** @internal */
			readonly processId: string;
			/** @internal */
			readonly availability: ProcessModelAvailabilitySnapshot;
	  }
	| {
			/** @internal */
			readonly kind: "compatible_profiles";
			/** @internal */
			readonly target: ModelPolicyTarget;
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
			readonly plan?: ProcessLaunchPlan;
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
	readonly invalidModelConfig?: "reject" | "retain";
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
/** @internal */
export type ModelPolicyTarget =
	| {
			/** @internal */
			readonly kind: "process_default";
	  }
	| {
			/** @internal */
			readonly kind: "turn";
			/** @internal */
			readonly turnId: string;
	  };
/** @internal */
export interface ModelRankingEvidence {
	/** @internal */
	readonly kind: "marked_defaults" | "cost_id";
	/** Equal-specificity marked defaults; ordered by the actual cost/ID tie-break. @internal */
	readonly tiedProfileIds: readonly string[];
}
/** @internal */
export interface SkippedModelPreference {
	/** @internal */
	readonly profileId: string;
	/** @internal */
	readonly source: ProcessSelectedTurnModelSource;
	/** @internal */
	readonly rejections: readonly ModelRequirementRejection[];
}
/** @internal */
export interface ModelRequirementRejection {
	/** @internal */ readonly origin: string;
	/** @internal */ readonly code: string;
	/** @internal */ readonly values: readonly string[];
}
export interface PolicyProfile {
	readonly labels: readonly string[];
	readonly default: boolean;
	readonly capabilities: Readonly<Record<string, boolean | "unknown">>;
	readonly id: string;
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: string;
	readonly providerOptions: Readonly<Record<string, unknown>>;
}
/** @internal */
export interface PolicyRequirementLayer {
	/** @internal */
	readonly origin: string;
	/** @internal */
	readonly requirements: import("@leitwerk-dev/protocol").ModelRequirements;
}
export interface PolicyProcess {
	readonly requirements: readonly PolicyRequirementLayer[];
	readonly turnRequirements: Readonly<Record<string, readonly PolicyRequirementLayer[]>>;
	readonly id: string;
	readonly allowedProfileIds: ReadonlySet<string> | null;
	readonly defaultProfileId: string | null;
	readonly turnProfileIds: Readonly<Record<string, string | null>>;
	readonly llmTurnIds: ReadonlySet<string>;
	readonly purposeProfileIdsByTurn: Readonly<Record<string, string>>;
	readonly scopedProfileIdForTurn?: (turnId: string) => string | null;
	readonly turnDescriptions: Readonly<Record<string, string>>;
	readonly turnPathTypes: Readonly<Record<string, string>>;
}
export interface PolicySnapshot {
	readonly defaultProfileId: string;
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

/** Launch/action choices stay pinned when inherited defaults are refreshed. @internal */
export function isPinnedModelSelection(
	selection: DurableModelSelection | null | undefined,
): boolean {
	return (
		selection?.provenance.source === "action_override" ||
		selection?.provenance.source === "launch_override"
	);
}
