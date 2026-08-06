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

export type ProcessModelAvailabilitySnapshot = ModelStatusCacheSnapshot;

export type PersistedModelConfigurationIssue = {
	readonly code: "invalid_turn_configs_json";
	readonly reason: "invalid_json" | "not_object" | "turn_config_not_object";
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

export type PersistedModelRelationalIssue =
	| { readonly code: "model_config_requires_llm_turn"; readonly turnId: string }
	| {
			readonly code: "selected_model_requires_selected_turn";
			readonly modelProfileId: string;
	  }
	| {
			readonly code: "selected_model_requires_llm_turn";
			readonly turnId: string;
			readonly modelProfileId: string;
	  };

export type PersistedModelSelectionIssue = {
	readonly code: "contradictory_provenance";
	readonly turnId: string;
	readonly modelProfileId: string;
	readonly kind: ModelSelectionKind;
	readonly source: ProcessSelectedTurnModelSource;
};

export type PersistedModelIntegrityIssue =
	| PersistedModelConfigurationIssue
	| PersistedModelRelationalIssue
	| PersistedModelSelectionIssue;

export type PersistedModelIntegrity =
	| { readonly kind: "valid" }
	| { readonly kind: "malformed"; readonly issues: readonly PersistedModelIntegrityIssue[] };

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

type ProcessModelPolicyFailureBase = {
	readonly ok: false;
	readonly selection: DurableModelSelection | null;
	readonly availabilityRevision?: number;
};

export type ProcessModelPolicyFailure = ProcessModelPolicyFailureBase &
	(
		| { readonly code: "model_required" }
		| { readonly code: "unknown_model_profile"; readonly modelProfileId: string }
		| {
				readonly code: "model_profile_not_allowed";
				readonly modelProfileId: string;
				readonly processId: string;
		  }
		| {
				readonly code: "model_unavailable" | "model_stale";
				readonly reason: string | null;
		  }
		| {
				readonly code: "invalid_model_configuration";
				readonly source: "configuration" | "selection_provenance";
				readonly issues: readonly (
					| PersistedModelConfigurationIssue
					| PersistedModelSelectionIssue
				)[];
		  }
		| { readonly code: "stale_evaluation_snapshot" }
	);
export interface ProcessModelPolicyResolution {
	readonly ok: true;
	readonly selection: DurableModelSelection | null;
	readonly availabilityRevision?: number;
}
export type ProcessModelPolicyEvaluation = ProcessModelPolicyResolution | ProcessModelPolicyFailure;

export interface ProjectedModelProfile {
	readonly id: string;
	readonly providerId: string;
	readonly modelId: string;
	readonly thinkingLevel: string;
	readonly availability: "available" | "unavailable" | "stale";
	readonly safeReason: string | null;
	readonly checkedAt: string | null;
}

export interface ProjectedModelDefault {
	readonly processConfigModelProfileId: string | null;
	readonly instanceModelProfileId: string | null;
	readonly effectiveModelProfileId: string | null;
	readonly source: "instance" | "process_config" | "catalog_default" | "none";
}

export type ProjectedModelResolutionSource = ProcessSelectedTurnModelSource | "none";

export interface ProjectedLauncherModelSchema {
	readonly profiles: readonly ProjectedModelProfile[];
	readonly turns: readonly { readonly turnId: string; readonly description: string }[];
}

export interface ProjectedLauncherModelPreview {
	readonly defaultModel: {
		readonly source: ProjectedModelDefault["source"];
		readonly profile: ProjectedModelProfile | null;
	};
	readonly turns: readonly {
		readonly turnId: string;
		readonly description: string;
		readonly effective: {
			readonly source: ProjectedModelResolutionSource;
			readonly profile: ProjectedModelProfile | null;
		};
	}[];
}

export type ProjectedProcessModelConfiguration = {
	readonly state:
		| { readonly kind: "ready" }
		| { readonly kind: "blocked"; readonly issues: readonly PersistedModelConfigurationIssue[] };
	readonly profiles: readonly ProjectedModelProfile[];
	readonly effectiveSelectedTurn: {
		readonly turnId: string;
		readonly description: string;
		readonly modelProfileId: string;
		readonly source: ProcessSelectedTurnModelSource;
	} | null;
	readonly defaultModel: ProjectedModelDefault;
	readonly turns: readonly {
		readonly turnId: string;
		readonly description: string;
		readonly pathType: string;
		readonly processConfigModelProfileId: string | null;
		readonly instanceModelProfileId: string | null;
		readonly effectiveConfiguredModelProfileId: string | null;
		readonly source: "instance" | "process_config" | "default";
	}[];
};

export interface ProcessModelPolicyProjectionByKind {
	readonly profile_options: readonly ProjectedModelProfile[];
	readonly compatible_profiles: readonly string[];
	readonly launcher_schema: ProjectedLauncherModelSchema;
	readonly launcher_preview: ProjectedLauncherModelPreview;
	readonly process_configuration: ProjectedProcessModelConfiguration;
}

export type ProcessModelPolicyEvaluationSubject =
	| {
			readonly kind: "process_turn";
			readonly process: ProcessInstance;
			readonly turnId: string;
			readonly availability?: ProcessModelAvailabilitySnapshot;
			readonly startKind?: TurnStartKind;
			/** True only when selecting the first turn of a persisted process. */
			readonly initialSelection?: boolean;
			readonly modelOverride?: string | null;
	  }
	| {
			readonly kind: "launch_plan_turn";
			readonly plan: ProcessLaunchPlan;
			readonly turnId: string;
			readonly availability: ProcessModelAvailabilitySnapshot;
	  }
	| {
			readonly kind: "runtime_selection";
			readonly processId: string;
			readonly selection: DurableModelSelection | null;
			readonly availability: ProcessModelAvailabilitySnapshot;
	  }
	| {
			readonly kind: "preparation_recovery";
			readonly cause: "availability_transition" | "startup_reconciliation";
			readonly process: ProcessInstance;
			readonly currentStart: TurnStartRecord;
			readonly availability: ProcessModelAvailabilitySnapshot;
	  };

export type ProcessModelPolicyProjectionSubject =
	| {
			readonly kind: "profile_options";
			readonly processId: string;
			readonly availability: ProcessModelAvailabilitySnapshot;
	  }
	| {
			readonly kind: "compatible_profiles";
			readonly processId: string;
			readonly providerId: string;
			readonly modelId: string;
			readonly availability: ProcessModelAvailabilitySnapshot;
	  }
	| {
			readonly kind: "launcher_schema";
			readonly processId: string;
			readonly availability?: ProcessModelAvailabilitySnapshot;
	  }
	| {
			readonly kind: "launcher_preview";
			readonly processId: string;
			readonly modelConfig: LaunchModelConfigInput;
			readonly availability: ProcessModelAvailabilitySnapshot;
	  }
	| {
			readonly kind: "process_configuration";
			readonly process: ProcessInstance;
			readonly availability: ProcessModelAvailabilitySnapshot;
	  };

export type ProcessModelPolicyProjectionKind = ProcessModelPolicyProjectionSubject["kind"];
export type ProcessModelPolicyProjectionSubjectFor<K extends ProcessModelPolicyProjectionKind> =
	Extract<ProcessModelPolicyProjectionSubject, { readonly kind: K }>;

export interface ProcessModelPolicyFingerprintSubject {
	readonly process: ProcessInstance;
	readonly currentStart: TurnStartRecord;
}

export interface PrepareLaunchPlanOptions {
	readonly modelConfig?: LaunchModelConfigInput;
	readonly replaceModelConfig?: boolean;
	readonly invalidModelConfig?: "reject" | "omit";
}

export interface ServerProcessModelPolicy {
	prepareLaunchPlan(
		launchPlan: ProcessLaunchPlan,
		opts?: PrepareLaunchPlanOptions,
	): LaunchPlanPreparationResultLike;
	inspectPersistedState(process: ProcessInstance): PersistedModelIntegrity;
	evaluate(request: ProcessModelPolicyEvaluationSubject): ProcessModelPolicyEvaluation;
	project<K extends ProcessModelPolicyProjectionKind>(
		request: ProcessModelPolicyProjectionSubjectFor<K>,
	): ProcessModelPolicyProjectionByKind[K];
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
