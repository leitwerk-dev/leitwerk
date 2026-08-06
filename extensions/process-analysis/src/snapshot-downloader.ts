import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveProcessRef } from "./process-ref.js";
import { getProcessAnalysisRuntime } from "./server-runtime.js";
import { buildRecordsMarkdown, buildSummaryMarkdown, jsonMarkdown } from "./snapshot-markdown.js";
import type { ProcessAnalysisSnapshotState } from "./state.js";

const SNAPSHOT_FETCH_TIMEOUT_MS = 30_000;

async function fetchJson(url: string): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(SNAPSHOT_FETCH_TIMEOUT_MS),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Network error fetching ${url}: ${message}`);
	}
	if (!response.ok)
		throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
	try {
		return await response.json();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON response from ${url}: ${message}`);
	}
}

async function writeJson(file: string, value: unknown): Promise<void> {
	await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function downloadProcessSnapshot(input: {
	analysisProcessId: string;
	processRef: string;
}): Promise<ProcessAnalysisSnapshotState> {
	const runtime = getProcessAnalysisRuntime();
	if (!runtime.processWorkspacesDir) throw new Error("processWorkspacesDir is not configured");
	const ref = resolveProcessRef({
		processRef: input.processRef,
		serverBaseUrl: runtime.serverBaseUrl,
	});
	const detail = await fetchJson(ref.apiUrl);
	const primaryPath = await fetchJson(`${ref.apiUrl}/primary-path`);
	const sourceWorkspace = path.join(runtime.processWorkspacesDir, ref.id);
	const baseDir = path.join(
		sourceWorkspace,
		".leitwerk",
		"process-analysis",
		input.analysisProcessId,
	);
	await mkdir(baseDir, { recursive: true });
	await writeJson(path.join(baseDir, "process-detail.json"), detail);
	await writeJson(path.join(baseDir, "primary-path.json"), primaryPath);
	await writeFile(
		path.join(baseDir, "summary.md"),
		buildSummaryMarkdown({ detail, primaryPath, sourceUrl: ref.apiUrl }),
		"utf8",
	);
	await writeFile(
		path.join(baseDir, "turn-records.md"),
		buildRecordsMarkdown(
			"Turn records",
			(detail as Record<string, unknown>).turnRecords ??
				(detail as Record<string, unknown>).turns ??
				[],
		),
		"utf8",
	);
	await writeFile(
		path.join(baseDir, "events.md"),
		buildRecordsMarkdown("Events", (detail as Record<string, unknown>).events ?? []),
		"utf8",
	);
	await writeFile(
		path.join(baseDir, "chronicle.md"),
		jsonMarkdown("Chronicle", (detail as Record<string, unknown>).chronicle ?? detail),
		"utf8",
	);
	return {
		sourceProcessId: ref.id,
		apiUrl: ref.apiUrl,
		snapshotDir: baseDir,
		primaryPath,
		downloadedAt: new Date().toISOString(),
	};
}
