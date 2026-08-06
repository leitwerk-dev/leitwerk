import {
	escapeLeafOutcomeHtml,
	LeafOutcomeCustomElement,
} from "@leitwerk-dev/process-sdk/leaf-outcome-renderer";

/**
 * @deprecated Compatibility renderer for historical local_repo_change_process leaf snapshots.
 * Removing this renderer is a breaking change for persisted snapshots whose rendererId is
 * @leitwerk-dev/local-repo-change:local_repo_change_process.leaf_outcome.
 */
interface LegacyLocalRepoChangeLeafOutcomePayload {
	markdown?: unknown;
	summary?: unknown;
	result?: unknown;
	[key: string]: unknown;
}

const TAG_NAME = "o2-local-repo-change-legacy-leaf-outcome";

function normalizeOptionalString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function stringifyPayload(payload: LegacyLocalRepoChangeLeafOutcomePayload | null): string {
	if (!payload) {
		return "{}";
	}
	try {
		return JSON.stringify(payload, null, 2) ?? "{}";
	} catch {
		return '{\n  "error": "Payload could not be serialized"\n}';
	}
}

class LegacyLocalRepoChangeLeafOutcomeElement extends LeafOutcomeCustomElement<LegacyLocalRepoChangeLeafOutcomePayload> {
	protected renderContent(): void {
		if (!this.canRender()) {
			return;
		}

		const runtime = this.runtime;
		const payload = this.payload;
		const markdown =
			normalizeOptionalString(payload?.markdown) ??
			normalizeOptionalString(payload?.result) ??
			normalizeOptionalString(payload?.summary);
		const capturedMarkup = this.meta?.createdAt
			? `<p class="legacy-meta">Captured ${escapeLeafOutcomeHtml(runtime.formatRelativeTime(this.meta.createdAt))}</p>`
			: "";
		const bodyMarkup = markdown
			? `<div class="legacy-markdown">${runtime.markdown.render(markdown)}</div>`
			: `<pre class="legacy-json">${escapeLeafOutcomeHtml(stringifyPayload(payload))}</pre>`;

		this.shadowRootRef.innerHTML = `
			<style>
				:host {
					display: block;
					color: var(--o2-text, #1f2933);
				}

				.legacy-wrap {
					display: grid;
					gap: var(--o2-space-md, 12px);
				}


				.legacy-meta {
					margin: 0;
					font-size: 12px;
					line-height: 1.5;
					color: var(--o2-text-muted, #667085);
				}

				.legacy-markdown {
					max-width: 68ch;
					font-size: 14px;
					line-height: 1.65;
				}

				.legacy-markdown :where(p, ul, ol, blockquote) {
					max-width: 68ch;
				}

				.legacy-markdown :where(pre, table) {
					max-width: 100%;
					overflow-x: auto;
				}

				.legacy-markdown :where(*:first-child) {
					margin-top: 0;
				}

				.legacy-markdown :where(*:last-child) {
					margin-bottom: 0;
				}

				.legacy-json {
					margin: 0;
					padding: 12px;
					overflow: auto;
					border: 1px solid var(--o2-border, #ddd4c8);
					border-radius: var(--o2-radius-sm, 12px);
					background: var(--o2-surface-muted, #f7f3ed);
					font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
					white-space: pre-wrap;
				}
			</style>
			<article class="legacy-wrap" data-renderer="local-repo-change-legacy-leaf-outcome">
				${bodyMarkup}
				${capturedMarkup}
			</article>
		`;
		this.emitReady();
	}
}

if (!customElements.get(TAG_NAME)) {
	customElements.define(TAG_NAME, LegacyLocalRepoChangeLeafOutcomeElement);
}
