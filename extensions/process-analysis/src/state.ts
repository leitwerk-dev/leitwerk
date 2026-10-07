import type { Codec, StructuralProcessState } from "@leitwerk-dev/process-sdk";
import { parseStructuralProcessState } from "@leitwerk-dev/process-sdk";

/** @internal */
export interface ProcessAnalysisSnapshotState {
	/** @internal */
	sourceProcessId: string;
	/** @internal */
	apiUrl: string;
	/** @internal */
	snapshotDir: string;
	/** @internal */
	primaryPath?: unknown;
	/** @internal */
	downloadedAt: string;
}

/** @internal */
export interface ProcessAnalysisState extends StructuralProcessState {
	/** @internal */
	snapshot: ProcessAnalysisSnapshotState | null;
}

/** @internal */
export function parseProcessAnalysisSnapshotState(
	value: unknown,
): ProcessAnalysisSnapshotState | null {
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

/** @internal */
export const processAnalysisStateCodec: Codec<ProcessAnalysisState> = {
	parse(value) {
		const r = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
		return {
			...parseStructuralProcessState(r),
			snapshot: parseProcessAnalysisSnapshotState(r.snapshot),
		};
	},
	serialize(value) {
		return value;
	},
};
