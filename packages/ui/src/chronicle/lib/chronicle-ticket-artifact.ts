export type ChronicleTicketArtifact =
	| { kind: "turn_result"; turnRecordId: string }
	| { kind: "leaf_outcome"; leafEntryId: string };
