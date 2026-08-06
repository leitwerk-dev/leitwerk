import type { Codec, StructuralProcessState } from "@leitwerk-dev/process-sdk";
import { parseStructuralProcessState } from "@leitwerk-dev/process-sdk";

export interface ProcessAnalysisSnapshotState {
	sourceProcessId: string;
	apiUrl: string;
	snapshotDir: string;
	primaryPath?: unknown;
	downloadedAt: string;
}

export interface ProcessAnalysisState extends StructuralProcessState {
	snapshot: ProcessAnalysisSnapshotState | null;
	pendingHandoffInput: Record<string, unknown> | null;
}

function parseSnapshot(value: unknown): ProcessAnalysisSnapshotState | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const r = value as Record<string, unknown>;
	if (typeof r.sourceProcessId !== "string" || typeof r.snapshotDir !== "string") return null;
	return {
		sourceProcessId: r.sourceProcessId,
		apiUrl: typeof r.apiUrl === "string" ? r.apiUrl : "",
		snapshotDir: r.snapshotDir,
		primaryPath: r.primaryPath,
		downloadedAt: typeof r.downloadedAt === "string" ? r.downloadedAt : "",
	};
}

export const processAnalysisStateCodec: Codec<ProcessAnalysisState> = {
	parse(value) {
		const r = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
		return {
			...parseStructuralProcessState(r),
			snapshot: parseSnapshot(r.snapshot),
			pendingHandoffInput:
				r.pendingHandoffInput && typeof r.pendingHandoffInput === "object"
					? (r.pendingHandoffInput as Record<string, unknown>)
					: null,
		};
	},
	serialize(value) {
		return value;
	},
};
