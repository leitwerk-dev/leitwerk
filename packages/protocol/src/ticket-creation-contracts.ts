import type { Actor, ProcessRelation, ProcessToolApprovalRequest } from "@leitwerk-dev/domain";

export interface TicketCreationToolSummary {
	name: string;
	displayName: string;
	description: string;
	parameters: Record<string, unknown>;
	titlePath?: string;
	descriptionPath?: string;
	requiresDestination: boolean;
}

export interface TicketCreationDestinationSummary {
	id: string;
	displayName: string;
	group?: string;
	description?: string;
	recent: boolean;
}

export interface TicketCreationDestinationListResponse {
	destinations: TicketCreationDestinationSummary[];
	warnings: string[];
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
	destinationId?: string;
	modelProfileId?: string;
}

export interface LaunchTicketCreationResponseBody {
	childInstanceId: string;
	relation: ProcessRelation;
}

export interface TicketCreationRelationSummary {
	relation: ProcessRelation;
	title: string | null;
	lifecycleStatus: string;
	toolName?: string;
	externalId?: string | null;
	externalUrl?: string | null;
}

export interface ResolveToolApprovalRequestBody {
	action: "accept" | "feedback" | "decline";
	feedback?: string;
}

export interface ResolveToolApprovalResponseBody {
	request: ProcessToolApprovalRequest;
	resolvedBy: Actor;
}
