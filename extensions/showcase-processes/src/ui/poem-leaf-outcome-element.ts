import {
	escapeLeafOutcomeHtml,
	LeafOutcomeCustomElement,
	normalizeLeafOutcomeOptionalText,
} from "@leitwerk-dev/process-sdk/leaf-outcome-renderer";

interface PoemLeafOutcomeReviewPayload {
	outcome?: unknown;
	summary?: unknown;
	feedback?: unknown;
}

interface PoemLeafOutcomePayload {
	prompt?: unknown;
	markdown?: unknown;
	title?: unknown;
	stanzas?: unknown;
	review?: unknown;
}

const TAG_NAME = "o2-showcase-processes-poem-outcome";
const SUPPORTED_SCHEMA_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePlaintextWithBreaks(value: string): string {
	return escapeLeafOutcomeHtml(value).replaceAll("\n", "<br>");
}

function parseReview(value: unknown): {
	outcome: "leave_feedback" | "no_issues";
	summary: string | null;
	feedback: string | null;
} | null {
	if (!isRecord(value)) {
		return null;
	}
	const review = value as PoemLeafOutcomeReviewPayload;
	if (review.outcome !== "leave_feedback" && review.outcome !== "no_issues") {
		return null;
	}
	return {
		outcome: review.outcome,
		summary: normalizeLeafOutcomeOptionalText(review.summary),
		feedback: normalizeLeafOutcomeOptionalText(review.feedback),
	};
}

class SinglePromptPoemOutcomeElement extends LeafOutcomeCustomElement<PoemLeafOutcomePayload> {
	protected renderContent(): void {
		if (!this.canRender()) {
			return;
		}
		const runtime = this.runtime;
		if (!runtime) {
			return;
		}
		if (this.meta?.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
			this.emitError(
				"unsupported_schema_version",
				`Poem outcome renderer expects schemaVersion=${SUPPORTED_SCHEMA_VERSION}`,
			);
			return;
		}

		const payload = this.payload;
		const markdown = typeof payload?.markdown === "string" ? payload.markdown.trim() : "";
		const review = parseReview(payload?.review);
		if (!markdown) {
			this.emitError("invalid_poem_payload", "Poem outcome payload must include markdown content.");
			return;
		}

		const reviewSummaryMarkup = review?.summary
			? `<p class="review-summary">${escapePlaintextWithBreaks(review.summary)}</p>`
			: "";
		const reviewFeedbackMarkup =
			review?.feedback && review.feedback !== review.summary
				? `<p class="review-feedback">${escapePlaintextWithBreaks(review.feedback)}</p>`
				: "";
		const reviewMarkup = review
			? `<section class="review-block ${review.outcome === "no_issues" ? "is-positive" : "is-feedback"}" data-review-outcome="${review.outcome}">
				<p class="review-label">${review.outcome === "no_issues" ? "LLM Opinion" : "Review"}</p>
				${reviewSummaryMarkup}
				${reviewFeedbackMarkup}
			</section>`
			: "";
		const capturedMarkup = this.meta?.createdAt
			? `<p class="meta-copy">Captured ${escapeLeafOutcomeHtml(runtime.formatRelativeTime(this.meta.createdAt))}</p>`
			: "";
		this.shadowRootRef.innerHTML = `
			<style>
				:host {
					display: block;
					color: var(--o2-text, #1f2933);
				}

				.wrap {
					display: grid;
					gap: var(--o2-space-lg, 18px);
				}

				.meta-copy,
				.review-label {
					margin: 0;
					font-size: 12px;
					letter-spacing: 0.04em;
					color: var(--o2-text-muted, #667085);
				}

				.review-label {
					text-transform: uppercase;
					font-weight: 700;
				}

				.poem-surface {
					padding: 18px 0 20px;
					border-top: 1px solid color-mix(in srgb, var(--o2-border, #ddd4c8) 82%, white 18%);
					background: transparent;
				}

				.poem-markdown {
					color: var(--o2-text, #1f2933);
					font-size: 16px;
					line-height: 1.75;
				}

				.poem-markdown :where(*:first-child) {
					margin-top: 0;
				}

				.poem-markdown :where(*:last-child) {
					margin-bottom: 0;
				}

				.poem-markdown :where(h1, h2, h3, h4, h5, h6) {
					margin: 0 0 14px;
					font-weight: 650;
					line-height: 1.05;
					letter-spacing: -0.02em;
					color: var(--o2-text, #1f2933);
				}

				.poem-markdown :where(h1) {
					font-size: 28px;
				}

				.poem-markdown :where(h2) {
					font-size: 24px;
				}

				.poem-markdown :where(h3) {
					font-size: 20px;
				}

				.poem-markdown :where(p) {
					margin: 0;
				}

				.poem-markdown :where(p + p) {
					margin-top: 14px;
				}

				.review-block {
					display: grid;
					gap: var(--o2-space-sm, 8px);
					padding: 16px 0 0;
					border-top: 1px solid color-mix(in srgb, var(--o2-border, #ddd4c8) 82%, white 18%);
					background: transparent;
				}

				.review-block.is-positive {
					border-top-color: color-mix(in srgb, #2f9e5f 30%, var(--o2-border, #ddd4c8) 70%);
				}

				.review-summary,
				.review-feedback {
					margin: 0;
					font-size: 14px;
					line-height: 1.6;
					color: var(--o2-text, #1f2933);
				}

				.review-feedback {
					color: var(--o2-text-muted, #53616f);
				}
			</style>
			<article class="wrap" data-renderer="showcase-processes-poem-outcome">
				<section class="poem-surface">
					<div class="poem-markdown">${runtime.markdown.render(markdown)}</div>
				</section>
				${reviewMarkup}
				${capturedMarkup}
			</article>
		`;
		this.emitReady();
	}
}

if (!customElements.get(TAG_NAME)) {
	customElements.define(TAG_NAME, SinglePromptPoemOutcomeElement);
}
