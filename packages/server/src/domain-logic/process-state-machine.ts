import type {
	ProcessLifecycleStatus,
	ProcessTurnTransition,
	TransitionTrigger,
	TurnId,
} from "@leitwerk-dev/domain";
import {
	getProcessGraph,
	getTurnTransitionsForProcessGraph,
	isTurnAvailableForProcessGraph,
	type ProcessGraphRegistry,
} from "../process-graph.js";

export type { TransitionTrigger };

export interface TransitionRule {
	fromTurnId: TurnId | null;
	toTurnId: TurnId | null;
	trigger?: TransitionTrigger | string;
}

export interface TransitionResult {
	ok: true;
	fromTurnId: TurnId | null;
	toTurnId: TurnId | null;
	trigger?: TransitionTrigger | string;
}

export interface TransitionError {
	ok: false;
	code: "invalid_transition" | "turn_unreachable";
	message: string;
	fromTurnId: TurnId | null;
	toTurnId: TurnId | null;
	trigger?: TransitionTrigger | string;
}

export interface OutcomeTransitionMatch {
	fromTurnId: TurnId;
	toTurnId: TurnId | null;
	lifecycleStatus?: "completed" | "aborted";
	outcome: string;
}

function matchesTrigger(
	transitionTrigger: string | undefined,
	requestedTrigger: string | undefined,
): boolean {
	if (requestedTrigger === undefined) {
		return true;
	}
	if (transitionTrigger === requestedTrigger) {
		return true;
	}
	if (requestedTrigger === "advance" && transitionTrigger === undefined) {
		return true;
	}
	return false;
}

function resolveTransitionTargetTurnId(transition: ProcessTurnTransition): TurnId | null {
	return transition.nextTurnId ?? null;
}

export function findOutcomeTransition(
	registry: ProcessGraphRegistry,
	processId: string,
	currentTurnId: TurnId,
	outcome: string,
): OutcomeTransitionMatch | null {
	const matches = getTurnTransitionsForProcessGraph(registry, processId, currentTurnId).filter(
		(candidate) =>
			candidate.trigger === undefined &&
			(candidate.outcome === undefined || candidate.outcome === outcome),
	);
	if (matches.length === 0) {
		return null;
	}
	if (matches.length > 1) {
		throw new Error(
			`Ambiguous outcome transition from '${currentTurnId}' for outcome '${outcome}': ${matches
				.map((candidate) => candidate.nextTurnId ?? candidate.lifecycleStatus ?? "null")
				.join(", ")}`,
		);
	}
	const match = matches[0];
	return {
		fromTurnId: currentTurnId,
		toTurnId: resolveTransitionTargetTurnId(match),
		...(match.lifecycleStatus !== undefined ? { lifecycleStatus: match.lifecycleStatus } : {}),
		outcome,
	};
}

export function tryTransition(
	registry: ProcessGraphRegistry,
	processId: string,
	currentTurnId: TurnId | null,
	trigger?: TransitionTrigger | string,
	targetTurnId?: TurnId | null,
	lifecycleStatus: ProcessLifecycleStatus = currentTurnId ? "active" : "discovered",
): TransitionResult | TransitionError {
	const def = getProcessGraph(registry, processId);

	if (currentTurnId === null) {
		if (lifecycleStatus !== "discovered") {
			return {
				ok: false,
				code: "invalid_transition",
				message: `Process '${processId}' is '${lifecycleStatus}' and has no selected turn`,
				fromTurnId: null,
				toTurnId: targetTurnId ?? null,
				...(trigger !== undefined ? { trigger } : {}),
			};
		}

		if (targetTurnId !== undefined) {
			if (targetTurnId === null || !def.entryTurnIds.has(targetTurnId)) {
				return {
					ok: false,
					code: "invalid_transition",
					message: `Turn '${String(targetTurnId)}' is not a declared entry turn for process '${processId}'`,
					fromTurnId: null,
					toTurnId: targetTurnId,
					...(trigger !== undefined ? { trigger } : {}),
				};
			}
			return {
				ok: true,
				fromTurnId: null,
				toTurnId: targetTurnId,
				...(trigger !== undefined ? { trigger } : { trigger: "start" }),
			};
		}

		return {
			ok: true,
			fromTurnId: null,
			toTurnId: def.primaryEntryTurnId,
			...(trigger !== undefined ? { trigger } : { trigger: "start" }),
		};
	}

	if (!isTurnAvailableForProcessGraph(registry, processId, currentTurnId)) {
		return {
			ok: false,
			code: "turn_unreachable",
			message: `Current turn '${currentTurnId}' is not declared for process '${processId}'`,
			fromTurnId: currentTurnId,
			toTurnId: targetTurnId ?? currentTurnId,
			...(trigger !== undefined ? { trigger } : {}),
		};
	}

	if (
		targetTurnId !== undefined &&
		targetTurnId !== null &&
		!isTurnAvailableForProcessGraph(registry, processId, targetTurnId)
	) {
		return {
			ok: false,
			code: "turn_unreachable",
			message: `Target turn '${targetTurnId}' is not declared for process '${processId}'`,
			fromTurnId: currentTurnId,
			toTurnId: targetTurnId,
			...(trigger !== undefined ? { trigger } : {}),
		};
	}

	const candidates = getTurnTransitionsForProcessGraph(registry, processId, currentTurnId).filter(
		(candidate) =>
			candidate.lifecycleStatus === undefined &&
			(targetTurnId === undefined || candidate.nextTurnId === targetTurnId) &&
			matchesTrigger(candidate.trigger, trigger),
	);

	if (candidates.length === 0) {
		return {
			ok: false,
			code: "invalid_transition",
			message:
				targetTurnId !== undefined
					? `No turn transition from '${currentTurnId}' to '${String(targetTurnId)}'` +
						(trigger !== undefined ? ` with trigger '${trigger}'` : "")
					: `No turn transition from '${currentTurnId}'` +
						(trigger !== undefined ? ` with trigger '${trigger}'` : ""),
			fromTurnId: currentTurnId,
			toTurnId: targetTurnId ?? currentTurnId,
			...(trigger !== undefined ? { trigger } : {}),
		};
	}

	if (targetTurnId === undefined && candidates.length > 1) {
		return {
			ok: false,
			code: "invalid_transition",
			message: `Ambiguous turn transition from '${currentTurnId}': ${candidates
				.map((candidate) => candidate.nextTurnId)
				.join(", ")}. Specify targetTurnId.`,
			fromTurnId: currentTurnId,
			toTurnId: currentTurnId,
			...(trigger !== undefined ? { trigger } : {}),
		};
	}

	const match = candidates[0];
	return {
		ok: true,
		fromTurnId: currentTurnId,
		toTurnId: match?.nextTurnId ?? null,
		...(trigger !== undefined
			? { trigger }
			: match?.trigger !== undefined
				? { trigger: match.trigger }
				: {}),
	};
}

export function canAbort(lifecycleStatus: ProcessLifecycleStatus): boolean {
	return lifecycleStatus !== "completed" && lifecycleStatus !== "aborted";
}
