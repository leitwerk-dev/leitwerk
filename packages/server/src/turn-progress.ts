import type { TurnProgressReport, TurnProgressStepStatus } from "@leitwerk-dev/domain";
import { createDurableWsFrame } from "@leitwerk-dev/protocol";
import type { RepositoryBundle } from "./db/repositories.js";
import type { Broadcaster } from "./ws/broadcast.js";

const STEP_STATUSES = new Set<TurnProgressStepStatus>([
	"incomplete",
	"in_progress",
	"completed",
	"failed",
]);
const LINK_KINDS = new Set(["pull_request", "merge_request", "commit", "pipeline", "other"]);

function text(value: unknown, max: number): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function safeExternalUrl(value: unknown): string {
	const candidate = text(value, 2_000);
	try {
		const url = new URL(candidate);
		return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
			? url.toString()
			: "";
	} catch {
		return "";
	}
}

export function normalizeTurnProgressReport(value: unknown): TurnProgressReport | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const title = text(raw.title, 160);
	if (!title || !Array.isArray(raw.steps) || raw.steps.length > 50) return null;
	const ids = new Set<string>();
	const steps = raw.steps.flatMap((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return [];
		const step = value as Record<string, unknown>;
		const id = text(step.id, 80);
		const label = text(step.label, 240);
		const status = step.status;
		if (!id || ids.has(id) || !label || !STEP_STATUSES.has(status as TurnProgressStepStatus)) {
			return [];
		}
		ids.add(id);
		return [
			{
				id,
				label,
				status: status as TurnProgressStepStatus,
				...(text(step.detail, 1_000) ? { detail: text(step.detail, 1_000) } : {}),
			},
		];
	});
	if (steps.length !== raw.steps.length || steps.length === 0) return null;
	const linkIds = new Set<string>();
	const rawLinks = raw.links === undefined ? [] : raw.links;
	if (!Array.isArray(rawLinks) || rawLinks.length > 20) return null;
	const links = rawLinks.flatMap((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return [];
		const link = value as Record<string, unknown>;
		const id = text(link.id, 80);
		const label = text(link.label, 240);
		const url = safeExternalUrl(link.url);
		const kind = text(link.kind, 40);
		if (!id || linkIds.has(id) || !label || !url) return [];
		if (kind && !LINK_KINDS.has(kind)) return [];
		linkIds.add(id);
		return [
			{
				id,
				label,
				url,
				...(kind ? { kind: kind as NonNullable<TurnProgressReport["links"]>[number]["kind"] } : {}),
			},
		];
	});
	if (links.length !== rawLinks.length) return null;
	return { title, steps, ...(links.length > 0 ? { links } : {}) };
}

export function recordTurnProgress(
	deps: Pick<RepositoryBundle, "processes" | "turnRecords" | "events"> & {
		broadcaster: Broadcaster;
	},
	input: { instanceId: string; turnRecordId: string; report: unknown },
): boolean {
	const process = deps.processes.getById(input.instanceId);
	const turnRecord = deps.turnRecords.getById(input.turnRecordId);
	const report = normalizeTurnProgressReport(input.report);
	if (
		!process ||
		!turnRecord ||
		turnRecord.instanceId !== input.instanceId ||
		turnRecord.status !== "running" ||
		process.selectedTurnId !== turnRecord.turnId ||
		!report
	)
		return false;
	const revision =
		deps.events.listByInstanceTurnRecordEventTypes(input.instanceId, input.turnRecordId, [
			"turn.progress",
		]).length + 1;
	deps.events.create({
		instanceId: input.instanceId,
		eventType: "turn.progress",
		data: { turnRecordId: input.turnRecordId, revision, report },
	});
	deps.broadcaster.broadcast(
		createDurableWsFrame({
			type: "process.event",
			instanceId: input.instanceId,
			payload: { eventType: "turn_progress", level: "info", message: "Turn progress updated" },
		}),
	);
	return true;
}
