import { normalizeMarkdownText } from "@leitwerk-dev/domain";
import type { PiTreeEntry } from "@leitwerk-dev/process-sdk";

export type PoemLeafOutcomeReviewOutcome = "no_issues" | "leave_feedback";

export interface PoemLeafOutcomeReview extends Record<string, unknown> {
	outcome: PoemLeafOutcomeReviewOutcome;
	summary: string | null;
	feedback: string | null;
}

export interface PoemLeafOutcomePayload extends Record<string, unknown> {
	prompt: string;
	markdown: string;
	title: string | null;
	stanzas: string[][];
	review?: PoemLeafOutcomeReview | null;
}

function normalizePoemBody(body: string): string {
	return body.replace(/<br\s*\/?>/gi, "\n");
}

function normalizeOptionalText(value: string | null | undefined): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function normalizeReview(
	review:
		| {
				outcome: PoemLeafOutcomeReviewOutcome;
				summary?: string | null;
				feedback?: string | null;
		  }
		| null
		| undefined,
): PoemLeafOutcomeReview | null {
	if (!review) {
		return null;
	}
	return {
		outcome: review.outcome,
		summary: normalizeOptionalText(review.summary),
		feedback: normalizeOptionalText(review.feedback),
	};
}

function uniqueNonEmptyStrings(values: Array<string | null>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (!value || seen.has(value)) {
			continue;
		}
		seen.add(value);
		result.push(value);
	}
	return result;
}

export function extractLeafEntryMarkdown(
	entry: Pick<PiTreeEntry, "message"> | null,
): string | null {
	const content = entry?.message?.content;
	return typeof content === "string" && content.trim() !== "" ? content.trim() : null;
}

export function resolvePoemLeafMarkdown(input: {
	turnResultMarkdown: string | null | undefined;
	leafEntry: Pick<PiTreeEntry, "message"> | null;
}): string {
	const turnResultMarkdown = input.turnResultMarkdown?.trim() ?? "";
	if (turnResultMarkdown !== "") {
		return turnResultMarkdown;
	}
	return extractLeafEntryMarkdown(input.leafEntry) ?? "";
}

export function parsePoemLeafMarkdown(markdown: string): {
	title: string | null;
	stanzas: string[][];
} {
	const normalized = normalizeMarkdownText(markdown);
	if (normalized === "") {
		return { title: null, stanzas: [] };
	}

	const lines = normalized.split("\n");
	let title: string | null = null;
	let bodyStartIndex = 0;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]?.trim() ?? "";
		if (line === "") {
			continue;
		}
		if (line.startsWith("#")) {
			title = line.replace(/^#{1,6}\s*/, "").trim() || null;
			bodyStartIndex = index + 1;
		}
		break;
	}

	const body = normalizePoemBody(lines.slice(bodyStartIndex).join("\n")).trim();
	if (body === "") {
		return { title, stanzas: [] };
	}

	const stanzas = body
		.split(/\n\s*\n+/)
		.map((stanza) =>
			stanza
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== ""),
		)
		.filter((stanza) => stanza.length > 0);

	return { title, stanzas };
}

export function buildPoemLeafOutcomePayload(input: {
	prompt: string;
	markdown: string;
	review?: {
		outcome: PoemLeafOutcomeReviewOutcome;
		summary?: string | null;
		feedback?: string | null;
	} | null;
}): PoemLeafOutcomePayload {
	const normalizedMarkdown = normalizeMarkdownText(input.markdown);
	const parsed = parsePoemLeafMarkdown(normalizedMarkdown);
	const review = normalizeReview(input.review);
	return {
		prompt: input.prompt,
		markdown: normalizedMarkdown,
		title: parsed.title,
		stanzas: parsed.stanzas,
		...(review ? { review } : {}),
	};
}

export function buildPoemLeafOutcomeFallbackMarkdown(input: {
	markdown: string;
	review?: {
		outcome: PoemLeafOutcomeReviewOutcome;
		summary?: string | null;
		feedback?: string | null;
	} | null;
}): string {
	const normalizedMarkdown = normalizeMarkdownText(input.markdown);
	const review = normalizeReview(input.review);
	if (!review) {
		return normalizedMarkdown;
	}

	const reviewSectionHeading = review.outcome === "no_issues" ? "## LLM Opinion" : "## Review";
	const reviewParagraphs =
		review.outcome === "no_issues"
			? uniqueNonEmptyStrings([review.summary ?? "The automated review found no issues."])
			: uniqueNonEmptyStrings([
					review.summary,
					review.feedback,
					review.summary === null && review.feedback === null
						? "The automated review reported issues but returned no details."
						: null,
				]);
	const reviewSection = [reviewSectionHeading, ...reviewParagraphs].join("\n\n");
	return [normalizedMarkdown, reviewSection]
		.filter((section) => section.trim() !== "")
		.join("\n\n");
}
