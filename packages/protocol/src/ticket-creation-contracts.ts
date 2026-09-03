import type { ProcessRelation } from "@leitwerk-dev/domain";

export interface TicketCreationToolSummary {
	name: string;
	displayName: string;
}

export type TicketResultArtifactLocator =
	| { kind: "turn_result"; turnRecordId: string }
	| { kind: "leaf_outcome"; leafEntryId: string };

export interface TicketCreationFocus {
	kind: "whole_result" | "excerpt";
	/** Browser-selected normalized text. The server still validates the artifact. */
	excerpt?: string;
}

export interface LaunchTicketCreationRequestBody {
	artifact: TicketResultArtifactLocator;
	focus: TicketCreationFocus;
	additionalInstructions?: string;
	toolName: string;
	modelProfileId?: string;
}

export interface LaunchTicketCreationResponseBody {
	childInstanceId: string;
	relation: ProcessRelation;
}

export interface ResolveToolApprovalRequestBody {
	action: "accept" | "feedback" | "decline";
	feedback?: string;
}
