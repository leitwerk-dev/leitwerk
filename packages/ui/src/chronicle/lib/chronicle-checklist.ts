export type ChronicleChecklistTone = "pending" | "active" | "success" | "failed" | "neutral";

export interface ChronicleChecklistStep {
	id: string;
	label: string;
	detail?: string | null;
	statusLabel: string;
	tone: ChronicleChecklistTone;
	sourceStatus: string;
}

export interface ChronicleChecklistLink {
	id: string;
	label: string;
	url: string;
}
