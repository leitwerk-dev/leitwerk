import type { ProcessRelation } from "@leitwerk-dev/domain";

/** @internal */
export interface TicketCreationToolSummary {
	/** @internal */
	name: string;
	/** @internal */
	displayName: string;
}

/** @internal */
export type TicketResultArtifactLocator =
	| {
			/** @internal */
			kind: "turn_result";
			/** @internal */
			turnRecordId: string;
	  }
	| {
			/** @internal */
			kind: "leaf_outcome";
			/** @internal */
			leafEntryId: string;
	  };

/** @internal */
export interface TicketCreationFocus {
	/** @internal */
	kind: "whole_result" | "excerpt";
	/** Browser-selected normalized text. The server still validates the artifact. */
	/** @internal */
	excerpt?: string;
}

/** @internal */
export interface LaunchTicketCreationRequestBody {
	/** @internal */
	artifact: TicketResultArtifactLocator;
	/** @internal */
	focus: TicketCreationFocus;
	/** @internal */
	additionalInstructions?: string;
	/** @internal */
	toolName: string;
	/** @internal */
	modelProfileId?: string;
}

/** @internal */
export interface LaunchTicketCreationResponseBody {
	/** @internal */
	childInstanceId: string;
	/** @internal */
	relation: ProcessRelation;
}

/** @internal */
export interface ResolveToolApprovalRequestBody {
	/** @internal */
	action: "accept" | "feedback" | "decline";
	/** @internal */
	feedback?: string;
}
