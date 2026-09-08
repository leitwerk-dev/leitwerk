import type { RepositoryBundle } from "./db/repositories.js";

const MAX_PREPARATION_BYTES = 65_536;

export function normalizeTurnPreparationData(
	value: unknown,
): { ok: true; data: unknown } | { ok: false } {
	if (value === undefined) return { ok: false };
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		return { ok: false };
	}
	if (Buffer.byteLength(serialized, "utf8") > MAX_PREPARATION_BYTES) return { ok: false };
	try {
		return { ok: true, data: JSON.parse(serialized) as unknown };
	} catch {
		return { ok: false };
	}
}

export function recordTurnPreparation(
	deps: Pick<RepositoryBundle, "processes" | "turnRecords" | "events">,
	input: { instanceId: string; turnRecordId: string; data: unknown },
): boolean {
	const process = deps.processes.getById(input.instanceId);
	const turnRecord = deps.turnRecords.getById(input.turnRecordId);
	const normalized = normalizeTurnPreparationData(input.data);
	if (
		!process ||
		!turnRecord ||
		turnRecord.instanceId !== input.instanceId ||
		turnRecord.status !== "running" ||
		turnRecord.turnType !== "llm" ||
		process.selectedTurnId !== turnRecord.turnId ||
		!normalized.ok
	) {
		return false;
	}
	const existing = deps.events.listByInstanceTurnRecordEventTypes(
		input.instanceId,
		input.turnRecordId,
		["turn.prepared"],
	);
	if (existing.length > 0) return false;
	deps.events.create({
		instanceId: input.instanceId,
		eventType: "turn.prepared",
		data: { turnRecordId: input.turnRecordId, data: normalized.data },
	});
	return true;
}
