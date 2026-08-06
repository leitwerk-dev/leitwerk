export type PromptHighlightSegmentKind = "context" | "user_input";

export interface PromptHighlightSegment {
	kind: PromptHighlightSegmentKind;
	text: string;
	start: number;
	end: number;
}

export type PromptHighlightMatchState = "matched" | "not_found" | "skipped";

export interface PromptHighlightResult {
	segments: PromptHighlightSegment[];
	matchState: PromptHighlightMatchState;
}

export const MIN_USER_INPUT_HIGHLIGHT_LENGTH = 4;

function isMeaningfulUserInput(value: string | null | undefined): value is string {
	return typeof value === "string" && value.trim().length >= MIN_USER_INPUT_HIGHLIGHT_LENGTH;
}

function contextSegment(text: string, start: number, end: number): PromptHighlightSegment | null {
	if (start >= end) {
		return null;
	}
	return { kind: "context", text, start, end };
}

export function buildPromptHighlightSegments(input: {
	fullPrompt: string;
	userInput?: string | null;
}): PromptHighlightResult {
	const { fullPrompt, userInput } = input;
	if (!isMeaningfulUserInput(userInput)) {
		return {
			segments: [{ kind: "context", text: fullPrompt, start: 0, end: fullPrompt.length }],
			matchState: "skipped",
		};
	}

	const segments: PromptHighlightSegment[] = [];
	let searchFrom = 0;
	let matchStart = fullPrompt.indexOf(userInput, searchFrom);
	while (matchStart >= 0) {
		const preceding = contextSegment(
			fullPrompt.slice(searchFrom, matchStart),
			searchFrom,
			matchStart,
		);
		if (preceding) {
			segments.push(preceding);
		}
		const matchEnd = matchStart + userInput.length;
		segments.push({
			kind: "user_input",
			text: fullPrompt.slice(matchStart, matchEnd),
			start: matchStart,
			end: matchEnd,
		});
		searchFrom = matchEnd;
		matchStart = fullPrompt.indexOf(userInput, searchFrom);
	}

	if (segments.length === 0) {
		return {
			segments: [{ kind: "context", text: fullPrompt, start: 0, end: fullPrompt.length }],
			matchState: "not_found",
		};
	}

	const trailing = contextSegment(fullPrompt.slice(searchFrom), searchFrom, fullPrompt.length);
	if (trailing) {
		segments.push(trailing);
	}

	return { segments, matchState: "matched" };
}
