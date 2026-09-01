import type { ServerExtensionAPI } from "@leitwerk-dev/process-sdk";
import { downloadProcessSnapshot } from "./snapshot-downloader.js";

export const processAnalysisDownloadSnapshotTool = "process_analysis_download_snapshot";

function parseArgs(value: unknown): { processRef: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Tool arguments must be an object");
	}
	const processRef = (value as Record<string, unknown>).processRef;
	if (typeof processRef !== "string" || !processRef.trim()) {
		throw new Error("'processRef' must be a non-empty string");
	}
	return { processRef: processRef.trim() };
}

export function registerProcessAnalysisTools(api: ServerExtensionAPI): void {
	api.tool({
		name: processAnalysisDownloadSnapshotTool,
		description: "Download a durable snapshot of a process for read-only analysis",
		parameters: {
			type: "object",
			properties: { processRef: { type: "string" } },
			required: ["processRef"],
			additionalProperties: false,
		},
		parse: parseArgs,
		execute(ctx, args) {
			return downloadProcessSnapshot({
				analysisProcessId: ctx.process.id,
				processRef: args.processRef,
			});
		},
	});
}
