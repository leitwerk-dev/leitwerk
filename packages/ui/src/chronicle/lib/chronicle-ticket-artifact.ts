export type ChronicleTicketArtifact =
	| { kind: "turn_result"; turnRecordId: string; text: string }
	| { kind: "leaf_outcome"; leafEntryId: string; text: string };
