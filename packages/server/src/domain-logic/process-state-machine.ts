import type { ProcessLifecycleStatus, TransitionTrigger, TurnId } from "@leitwerk-dev/domain";
import {
	getProcessGraph,
	getTurnTransitionsForProcessGraph,
	isTurnAvailableForProcessGraph,
	type ProcessGraphRegistry,
} from "../process-graph.js";

export type { TransitionTrigger };

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
	return (
		requestedTrigger === undefined ||
		transitionTrigger === requestedTrigger ||
		(requestedTrigger === "advance" && transitionTrigger === undefined)
	);
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
		toTurnId: match.nextTurnId ?? null,
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
	const fail = (code: TransitionError["code"], message: string): TransitionError => ({
		ok: false,
		code,
		message,
		fromTurnId: currentTurnId,
		toTurnId: targetTurnId ?? currentTurnId,
		...(trigger !== undefined ? { trigger } : {}),
	});

	if (currentTurnId === null) {
		if (lifecycleStatus !== "discovered") {
			return fail(
				"invalid_transition",
				`Process '${processId}' is '${lifecycleStatus}' and has no selected turn`,
			);
		}
		if (
			targetTurnId !== undefined &&
			(targetTurnId === null || !def.entryTurnIds.has(targetTurnId))
		) {
			return fail(
				"invalid_transition",
				`Turn '${String(targetTurnId)}' is not a declared entry turn for process '${processId}'`,
			);
		}
		return {
			ok: true,
			fromTurnId: null,
			toTurnId: targetTurnId ?? def.primaryEntryTurnId,
			trigger: trigger ?? "start",
		};
	}

	if (!isTurnAvailableForProcessGraph(registry, processId, currentTurnId)) {
		return fail(
			"turn_unreachable",
			`Current turn '${currentTurnId}' is not declared for process '${processId}'`,
		);
	}
	if (
		targetTurnId !== undefined &&
		targetTurnId !== null &&
		!isTurnAvailableForProcessGraph(registry, processId, targetTurnId)
	) {
		return fail(
			"turn_unreachable",
			`Target turn '${targetTurnId}' is not declared for process '${processId}'`,
		);
	}

	const candidates = getTurnTransitionsForProcessGraph(registry, processId, currentTurnId).filter(
		(candidate) =>
			candidate.lifecycleStatus === undefined &&
			(targetTurnId === undefined || candidate.nextTurnId === targetTurnId) &&
			matchesTrigger(candidate.trigger, trigger),
	);

	if (candidates.length === 0) {
		return fail(
			"invalid_transition",
			`No turn transition from '${currentTurnId}'` +
				(targetTurnId !== undefined ? ` to '${String(targetTurnId)}'` : "") +
				(trigger !== undefined ? ` with trigger '${trigger}'` : ""),
		);
	}

	if (targetTurnId === undefined && candidates.length > 1) {
		return fail(
			"invalid_transition",
			`Ambiguous turn transition from '${currentTurnId}': ${candidates
				.map((candidate) => candidate.nextTurnId)
				.join(", ")}. Specify targetTurnId.`,
		);
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
