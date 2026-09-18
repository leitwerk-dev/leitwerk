import type {
	ProcessInstance,
	ProcessLeafOutcomeSnapshot,
	ProcessProject,
	ProcessQuestionRequest,
	ProcessTurnRecord,
	WorkerErrorClass,
} from "@leitwerk-dev/domain";

/** @internal */
export interface ProcessCreatedEvent {
	/** @internal */
	instanceId: string;
	/** @internal */
	process: ProcessInstance;
	/** @internal */
	projects: readonly ProcessProject[];
	/** @internal */
	launcherId?: string | null;
}

/** @internal */
export interface ProcessUpdatedEvent {
	/** @internal */
	instanceId: string;
	/** @internal */
	process: ProcessInstance;
	/** @internal */
	changedFields: readonly string[];
}

/** @internal */
export interface TurnStartedEvent {
	/** @internal */
	instanceId: string;
	/** @internal */
	turnRecord: ProcessTurnRecord;
}

/** @internal */
export interface TurnFailedEvent {
	/** @internal */
	instanceId: string;
	/** @internal */
	turnRecord: ProcessTurnRecord;
	/** @internal */
	errorSummary: string;
	/** @internal */
	errorClass?: WorkerErrorClass | null;
}

/** @internal */
export interface LeafOutcomeCapturedEvent {
	/** @internal */
	instanceId: string;
	/** @internal */
	snapshot: ProcessLeafOutcomeSnapshot;
}

/** @internal */
export interface ReviewRequestedEvent {
	/** @internal */
	instanceId: string;
	/** @internal */
	workerId?: string;
	/** @internal */
	changedProjects: string[];
}

/** @internal */
export interface QuestionRequestedEvent {
	/** @internal */
	instanceId: string;
	/** @internal */
	request: ProcessQuestionRequest;
}

/** @internal */
export interface TurnOutcomeEvent {
	/** @internal */
	instanceId: string;
	/** @internal */
	turnRecordId: string;
	/** @internal */
	turnId: string;
	/** @internal */
	outcome: string;
	/** @internal */
	params: Record<string, unknown>;
	/** @internal */
	turnResultMarkdown?: string | null;
}

/** @internal */
export interface PlanApprovedEvent {
	/** @internal */
	instanceId: string;
	/** @internal */
	externalId: string | null;
	/** @internal */
	planRevision: number;
}

/** @internal */
export interface PlanRevisionRequestedEvent {
	/** @internal */
	instanceId: string;
	/** @internal */
	message: string;
}

/** @internal */
export interface PlanSavedEvent {
	/** @internal */
	instanceId: string;
	/** @internal */
	planRevision: number;
	/** @internal */
	summary: string;
	/** @internal */
	planMarkdown: string;
	/** @internal */
	acceptanceCriteria: string[];
}

/** @internal */
export interface ReviewCompletedEvent {
	/** @internal */
	instanceId: string;
	/** @internal */
	hasIssues: boolean;
	/** @internal */
	issueCount: number;
	/** @internal */
	reviewMarkdown?: string;
}

/** @internal */
export interface ServerExtensionEventMap {
	/** @internal */
	process_created: ProcessCreatedEvent;
	/** @internal */
	process_updated: ProcessUpdatedEvent;
	/** @internal */
	turn_started: TurnStartedEvent;
	/** @internal */
	turn_failed: TurnFailedEvent;
	/** @internal */
	leaf_outcome_captured: LeafOutcomeCapturedEvent;
	/** @internal */
	question_requested: QuestionRequestedEvent;
	/** @internal */
	review_requested: ReviewRequestedEvent;
	/** @internal */
	turn_outcome: TurnOutcomeEvent;
	/** @internal */
	plan_approved: PlanApprovedEvent;
	/** @internal */
	plan_revision_requested: PlanRevisionRequestedEvent;
	/** @internal */
	plan_saved: PlanSavedEvent;
	/** @internal */
	review_completed: ReviewCompletedEvent;
}

/** @internal */
export type ServerExtensionEventName = keyof ServerExtensionEventMap;

/** @internal */
export type ServerExtensionEventPayloadInputMap = {
	[K in keyof ServerExtensionEventMap]: Omit<ServerExtensionEventMap[K], "instanceId">;
};
