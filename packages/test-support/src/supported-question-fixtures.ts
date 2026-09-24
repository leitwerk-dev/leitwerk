import { type Actor, normalizeAskQuestionsInput } from "@leitwerk-dev/domain";

/** A normalized question with stable option identities. @public */
export interface QuestionFixture {
	/** @public */
	id: string;
	/** @public */
	question: string;
	/** @public */
	selection: "single" | "multiple";
	/** @public */
	options: readonly {
		/** @public */
		id: string;
		/** @public */
		label: string;
		/** @public */
		details: string | null;
	}[];
}

/** Correlated question request data without persistence access. @public */
export interface QuestionRequestFixture {
	/** @public */
	id: string;
	/** @public */
	instanceId: string;
	/** @public */
	turnRecordId: string;
	/** @public */
	toolCallId: string;
	/** @public */
	questions: readonly QuestionFixture[];
	/** @public */
	status: "open" | "answered" | "cancelled";
	/** @public */
	answers: readonly string[] | null;
	/** @public */
	askedAt: string;
	/** @public */
	answeredAt: string | null;
	/** @public */
	answeredBy: Actor | null;
	/** @public */
	cancelledAt: string | null;
}

/** Question content with generated stable option identities. @public */
export interface QuestionFixtureOptions {
	/** @public */
	question?: string;
	/** @public */
	selection?: "single" | "multiple";
	/** @public */
	options?: readonly {
		/** @public */
		label: string;
		/** @public */
		details?: string | null;
	}[];
}

/** Normalize content using the application's question contract. @public */
export function createQuestionFixture(options: QuestionFixtureOptions = {}): QuestionFixture {
	const [question] = normalizeAskQuestionsInput({
		questions: [
			{
				question: options.question ?? "Choose a strategy",
				selection: options.selection ?? "single",
				options: options.options ?? [{ label: "Safe", details: "Small change" }],
			},
		],
	});
	if (!question) throw new Error("Question normalization returned no question");
	return question;
}

/** Resolution determines status and all resolution timestamps. @public */
export type QuestionFixtureResolution =
	| {
			/** @public */
			status: "answered";
			/** @public */
			answers: readonly string[];
			/** @public */
			actor?: Actor;
	  }
	| {
			/** @public */
			status: "cancelled";
	  };

/** Reference inputs and question content, without durable status overrides. @public */
export interface QuestionRequestFixtureOptions {
	/** @public */
	id?: string;
	/** @public */
	process?: {
		/** @public */
		id: string;
	};
	/** @public */
	turn?: {
		/** @public */
		id: string;
		/** @public */
		instanceId: string;
	};
	/** @public */
	questions?: readonly QuestionFixtureOptions[];
	/** @public */
	resolution?: QuestionFixtureResolution;
}

/** Create a consistent request; reject conflicting process and turn references. @public */
export function createQuestionRequestFixture(
	options: QuestionRequestFixtureOptions = {},
): QuestionRequestFixture {
	const instanceId = options.process?.id ?? options.turn?.instanceId ?? "agt_test";
	if (options.turn && options.turn.instanceId !== instanceId)
		throw new Error("Question turn belongs to another process");
	const questions = normalizeAskQuestionsInput({
		questions: (options.questions ?? [{}]).map((q) => ({
			question: q.question ?? "Choose a strategy",
			selection: q.selection ?? "single",
			options: q.options ?? [{ label: "Safe" }],
		})),
	});
	const resolution = options.resolution;
	if (resolution?.status === "answered" && resolution.answers.length !== questions.length)
		throw new Error("Supply one answer per question");
	return {
		id: options.id ?? "qst_test",
		instanceId,
		turnRecordId: options.turn?.id ?? "trn_test",
		toolCallId: "tool_test",
		questions,
		status: resolution?.status ?? "open",
		askedAt: "2026-01-01T00:00:00.000Z",
		answers: resolution?.status === "answered" ? [...resolution.answers] : null,
		answeredAt: resolution?.status === "answered" ? "2026-01-01T00:00:01.000Z" : null,
		answeredBy:
			resolution?.status === "answered"
				? structuredClone(resolution.actor ?? { id: "test-user", kind: "user", provider: null })
				: null,
		cancelledAt: resolution?.status === "cancelled" ? "2026-01-01T00:00:01.000Z" : null,
	};
}
