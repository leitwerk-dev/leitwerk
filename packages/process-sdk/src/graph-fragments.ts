import type { InputKind, InputSource, ProcessInputTarget } from "@leitwerk-dev/domain";
import type {
	ProcessActionEffect,
	ProcessActionExecution,
	ProcessEffectPlan,
	ProcessHumanTurnActionSpec,
} from "./define-process.js";

/** @internal */
type MaybePromise<T> = T | Promise<T>;
/** @internal */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function appendQueuedInstruction<TState>(input: {
	plan: ProcessEffectPlan<TState> | undefined;
	bodyMarkdown: string | null | undefined;
	queueTarget?: ProcessInputTarget;
	queueSource?: InputSource;
	queueKind?: InputKind;
}) {
	if (input.bodyMarkdown == null) {
		return input.plan;
	}
	if (input.bodyMarkdown.trim() === "") {
		throw new Error("Queued instruction bodyMarkdown must not be empty");
	}
	return {
		...(input.plan ?? {}),
		queueInput: [
			...(input.plan?.queueInput ?? []),
			{
				source: input.queueSource ?? "action_prompt",
				kind: input.queueKind ?? "instruction",
				...(input.queueTarget ? { target: input.queueTarget } : {}),
				bodyMarkdown: input.bodyMarkdown,
			},
		],
	};
}

/** @internal */
export type QueuedInstructionActionSpec<TParams = unknown, TState = unknown> = DistributiveOmit<
	ProcessHumanTurnActionSpec<TParams, TState>,
	"effect"
> & {
	/** @internal */
	queueTarget?: ProcessInputTarget;
	/** @internal */
	queueSource?: InputSource;
	/** @internal */
	queueKind?: InputKind;
	/** @internal */
	resolveBodyMarkdown(
		input: ProcessActionExecution<TParams, TState>,
	): MaybePromise<string | null | undefined>;
	/** @internal */
	effect?: ProcessActionEffect<TParams, TState>;
};

/** @internal */
export function queuedInstructionAction<TParams = unknown, TState = unknown>(
	spec: QueuedInstructionActionSpec<TParams, TState>,
): ProcessHumanTurnActionSpec<TParams, TState> {
	const { queueTarget, queueSource, queueKind, resolveBodyMarkdown, effect, ...rest } = spec;
	return {
		...rest,
		async effect(input) {
			const bodyMarkdown = await resolveBodyMarkdown(input);
			const plan = effect ? await effect(input) : undefined;
			return appendQueuedInstruction({
				plan,
				bodyMarkdown,
				queueTarget,
				queueSource,
				queueKind,
			});
		},
	} as ProcessHumanTurnActionSpec<TParams, TState>;
}

/** @internal */
export type RevisionActionSpec<TParams = unknown, TState = unknown> = DistributiveOmit<
	QueuedInstructionActionSpec<TParams, TState>,
	"resolveBodyMarkdown"
> & {
	/** @internal */
	messageFieldId?: string;
	/** @internal */
	missingMessageError?: string;
};

/** @internal */
export function revisionAction<TParams = unknown, TState = unknown>(
	spec: RevisionActionSpec<TParams, TState>,
): ProcessHumanTurnActionSpec<TParams, TState> {
	const { messageFieldId = "message", missingMessageError, ...rest } = spec;
	return queuedInstructionAction({
		...rest,
		resolveBodyMarkdown({ input }) {
			const message = typeof input[messageFieldId] === "string" ? input[messageFieldId].trim() : "";
			if (!message) {
				throw new Error(missingMessageError ?? `${messageFieldId} is required`);
			}
			return message;
		},
	});
}

/** @internal */
export type AcceptedReviewHandoffActionSpec<TParams = unknown, TState = unknown> = DistributiveOmit<
	QueuedInstructionActionSpec<TParams, TState>,
	"queueTarget"
> & {
	/** @internal */
	queueTarget?: ProcessInputTarget;
};

/** @internal */
export function acceptedReviewHandoffAction<TParams = unknown, TState = unknown>(
	spec: AcceptedReviewHandoffActionSpec<TParams, TState>,
): ProcessHumanTurnActionSpec<TParams, TState> {
	return queuedInstructionAction({
		...spec,
		queueTarget: spec.queueTarget ?? { semanticRef: "currentPrimaryPathLeaf" },
	});
}
