import type { ProcessInstance, ProcessProject, ProcessTurnRecord } from "@leitwerk-dev/domain";
import {
	normalizeLeafOutcomeCaptureResult,
	type PiTreeEntry,
	validateLeafOutcomeCaptureResult,
} from "@leitwerk-dev/process-sdk";
import type { CreateProcessLeafOutcomeSnapshotInput } from "./db/process-leaf-outcome-snapshot-repo.js";
import type { ProcessActionRegistry } from "./process-action-registry.js";
import type { ProcessSessionReader } from "./process-session-store.js";
import type { ProcessUiRegistry } from "./process-ui-registry.js";

interface TurnRecordAccess {
	getById(id: string): ProcessTurnRecord | null;
}

function cloneTreeEntry(entry: PiTreeEntry | null): PiTreeEntry | null {
	return entry ? { ...entry } : null;
}

function toWarningMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim() !== "") {
		return error.message;
	}
	return String(error);
}

function captureErrorSnapshot(input: {
	instanceId: string;
	leafEntryId: string;
	turnRecordId: string | null;
	rendererId: string | null;
	fallbackMarkdown?: string | null;
	warningCode: string;
	warningMessage: string;
	anchoredAt: string;
}): CreateProcessLeafOutcomeSnapshotInput {
	return {
		instanceId: input.instanceId,
		leafEntryId: input.leafEntryId,
		turnRecordId: input.turnRecordId,
		rendererId: input.rendererId,
		schemaVersion: null,
		props: null,
		fallbackMarkdown: input.fallbackMarkdown ?? null,
		status: "capture_error",
		warningCode: input.warningCode,
		warningMessage: input.warningMessage,
		anchoredAt: input.anchoredAt,
	};
}

export interface CaptureLeafOutcomeSnapshotOptions {
	process: ProcessInstance;
	projects: readonly ProcessProject[];
	processActionRegistry: ProcessActionRegistry;
	processUiRegistry: ProcessUiRegistry;
	turnRecords: TurnRecordAccess;
	sessionReader: ProcessSessionReader;
	leaf: {
		entryId: string;
		turnRecordId: string | null;
	};
	turnRecord: ProcessTurnRecord | null;
	anchoredAt: string;
}

export async function captureLeafOutcomeSnapshot(
	options: CaptureLeafOutcomeSnapshotOptions,
): Promise<CreateProcessLeafOutcomeSnapshotInput | null> {
	const leafOutcomeDefinition = options.processUiRegistry.getLeafOutcomeDefinition(
		options.process.processId,
	);
	if (!leafOutcomeDefinition) {
		return null;
	}

	const { params, state } = options.processActionRegistry.resolveContextData(
		options.process.processId,
		options.process,
	);
	const tree = await options.sessionReader.readInstanceTree(options.process.id);
	const readTreeEntry = (entryId: string): PiTreeEntry | null =>
		cloneTreeEntry((tree.entriesById.get(entryId) as PiTreeEntry | undefined) ?? null);
	const readLeafEntry = (): PiTreeEntry | null => readTreeEntry(options.leaf.entryId);

	try {
		const rawResult = await leafOutcomeDefinition.capture({
			process: options.process,
			projects: options.projects,
			params,
			state,
			leaf: {
				entryId: options.leaf.entryId,
				turnRecordId: options.leaf.turnRecordId,
			},
			turnRecord: options.turnRecord,
			readTreeEntry,
			readLeafEntry,
			readTurnRecord(turnRecordId: string) {
				return options.turnRecords.getById(turnRecordId);
			},
		});
		if (rawResult === null) {
			return null;
		}
		const validationErrors = validateLeafOutcomeCaptureResult(
			rawResult,
			leafOutcomeDefinition.rendererId,
		);
		if (validationErrors.length > 0) {
			const fallbackMarkdown =
				typeof (rawResult as { fallbackMarkdown?: unknown })?.fallbackMarkdown === "string"
					? (rawResult as { fallbackMarkdown: string }).fallbackMarkdown
					: null;
			return captureErrorSnapshot({
				instanceId: options.process.id,
				leafEntryId: options.leaf.entryId,
				turnRecordId: options.leaf.turnRecordId,
				rendererId: leafOutcomeDefinition.rendererId,
				fallbackMarkdown,
				warningCode: "invalid_capture_result",
				warningMessage: validationErrors.join("; "),
				anchoredAt: options.anchoredAt,
			});
		}
		const result = normalizeLeafOutcomeCaptureResult(rawResult);
		return {
			instanceId: options.process.id,
			leafEntryId: options.leaf.entryId,
			turnRecordId: options.leaf.turnRecordId,
			rendererId: result.rendererId,
			schemaVersion: result.schemaVersion ?? null,
			props: result.props,
			fallbackMarkdown: result.fallbackMarkdown ?? null,
			status: "ready",
			warningCode: null,
			warningMessage: null,
			anchoredAt: options.anchoredAt,
		};
	} catch (error) {
		return captureErrorSnapshot({
			instanceId: options.process.id,
			leafEntryId: options.leaf.entryId,
			turnRecordId: options.leaf.turnRecordId,
			rendererId: leafOutcomeDefinition.rendererId,
			warningCode: "capture_exception",
			warningMessage: toWarningMessage(error),
			anchoredAt: options.anchoredAt,
		});
	}
}
