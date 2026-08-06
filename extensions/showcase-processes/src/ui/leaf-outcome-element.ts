import {
	escapeLeafOutcomeHtml,
	LeafOutcomeCustomElement,
} from "@leitwerk-dev/process-sdk/leaf-outcome-renderer";

interface SinglePromptLeafOutcomePayload {
	prompt?: unknown;
	markdown?: unknown;
	leafEntryId?: unknown;
	turnRecordId?: unknown;
}

const TAG_NAME = "o2-showcase-processes-leaf-outcome";

class SinglePromptLeafOutcomeElement extends LeafOutcomeCustomElement<SinglePromptLeafOutcomePayload> {
	protected renderContent(): void {
		if (!this.canRender()) {
			return;
		}
		const runtime = this.runtime;
		if (!runtime) {
			return;
		}
		const payload = this.payload;
		const markdown = typeof payload?.markdown === "string" ? payload.markdown.trim() : "";
		if (!markdown) {
			this.emitError(
				"missing_markdown_payload",
				"The selected-leaf snapshot payload did not include markdown content.",
			);
			return;
		}
		const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
		const relativeTime =
			this.meta && typeof this.meta.createdAt === "string"
				? runtime.formatRelativeTime(this.meta.createdAt)
				: null;
		const promptMarkup = prompt ? `<p class="prompt">${escapeLeafOutcomeHtml(prompt)}</p>` : "";
		const metaMarkup = relativeTime
			? `<p class="meta">Captured ${escapeLeafOutcomeHtml(relativeTime)}</p>`
			: "";
		this.shadowRootRef.innerHTML = `
			<style>
				:host {
					display: block;
					color: var(--o2-text, #1f2933);
				}

				.wrap {
					display: flex;
					flex-direction: column;
					gap: var(--o2-space-md, 12px);
				}

				.prompt,
				.meta {
					margin: 0;
					font-size: 12px;
					line-height: 1.5;
					color: var(--o2-text-muted, #667085);
				}

				.prompt {
					padding: var(--o2-space-sm, 8px) 0;
					border-top: 1px solid color-mix(in srgb, var(--o2-border, #ddd4c8) 78%, white 22%);
					border-bottom: 1px solid color-mix(in srgb, var(--o2-border, #ddd4c8) 54%, white 46%);
				}

				.markdown {
					color: var(--o2-text, #1f2933);
					font-size: 14px;
					line-height: 1.65;
				}

				.markdown :where(*:first-child) {
					margin-top: 0;
				}

				.markdown :where(*:last-child) {
					margin-bottom: 0;
				}
			</style>
			<article class="wrap" data-renderer="showcase-processes-leaf-outcome">
				${promptMarkup}
				<div class="markdown">${runtime.markdown.render(markdown)}</div>
				${metaMarkup}
			</article>
		`;
		this.emitReady();
	}
}

if (!customElements.get(TAG_NAME)) {
	customElements.define(TAG_NAME, SinglePromptLeafOutcomeElement);
}
