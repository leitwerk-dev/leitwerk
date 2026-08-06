import type {
	ProcessInstance,
	ProcessLeafOutcomeSnapshot,
	ProcessProject,
	ProcessQuestionRequest,
	ProcessTurnRecord,
	WorkerErrorClass,
} from "@leitwerk-dev/domain";

export interface ProcessCreatedEvent {
	instanceId: string;
	process: ProcessInstance;
	projects: readonly ProcessProject[];
	launcherId?: string | null;
}

export interface ProcessUpdatedEvent {
	instanceId: string;
	process: ProcessInstance;
	changedFields: readonly string[];
}

export interface TurnStartedEvent {
	instanceId: string;
	turnRecord: ProcessTurnRecord;
}

export interface TurnFailedEvent {
	instanceId: string;
	turnRecord: ProcessTurnRecord;
	errorSummary: string;
	errorClass?: WorkerErrorClass | null;
}

export interface LeafOutcomeCapturedEvent {
	instanceId: string;
	snapshot: ProcessLeafOutcomeSnapshot;
}

export interface ReviewRequestedEvent {
	instanceId: string;
	workerId?: string;
	changedProjects: string[];
}

export interface QuestionRequestedEvent {
	instanceId: string;
	request: ProcessQuestionRequest;
}

export interface TurnOutcomeEvent {
	instanceId: string;
	turnRecordId: string;
	turnId: string;
	outcome: string;
	params: Record<string, unknown>;
	turnResultMarkdown?: string | null;
}

export interface PlanApprovedEvent {
	instanceId: string;
	externalId: string | null;
	planRevision: number;
}

export interface PlanRevisionRequestedEvent {
	instanceId: string;
	message: string;
}

export interface PlanSavedEvent {
	instanceId: string;
	planRevision: number;
	summary: string;
	planMarkdown: string;
	acceptanceCriteria: string[];
}

export interface ReviewCompletedEvent {
	instanceId: string;
	hasIssues: boolean;
	issueCount: number;
	reviewMarkdown?: string;
}

export interface ServerExtensionEventMap {
	process_created: ProcessCreatedEvent;
	process_updated: ProcessUpdatedEvent;
	turn_started: TurnStartedEvent;
	turn_failed: TurnFailedEvent;
	leaf_outcome_captured: LeafOutcomeCapturedEvent;
	question_requested: QuestionRequestedEvent;
	review_requested: ReviewRequestedEvent;
	turn_outcome: TurnOutcomeEvent;
	plan_approved: PlanApprovedEvent;
	plan_revision_requested: PlanRevisionRequestedEvent;
	plan_saved: PlanSavedEvent;
	review_completed: ReviewCompletedEvent;
}

export type ServerExtensionEventName = keyof ServerExtensionEventMap;

export type ServerExtensionEventPayloadInputMap = {
	[K in keyof ServerExtensionEventMap]: Omit<ServerExtensionEventMap[K], "instanceId">;
};
