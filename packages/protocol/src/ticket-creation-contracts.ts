import type { ProcessRelation } from "@leitwerk-dev/domain";

export interface TicketCreationToolSummary {
	name: string;
	displayName: string;
}

export interface TicketResultArtifactLocator {
	kind: "turn_result" | "leaf_outcome";
	turnRecordId?: string;
	leafEntryId?: string;
}

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
