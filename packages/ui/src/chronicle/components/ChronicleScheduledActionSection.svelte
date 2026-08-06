<script lang="ts">
import type { ScheduledActionDetail } from "../../lib/api.js";
import { formatLocalDateTime24Hour, formatUtcDateTime24Hour } from "../../lib/format.js";

interface Props {
	anchorId: string;
	isFocused: boolean;
	scheduledAction: ScheduledActionDetail;
	busy?: boolean;
	error?: string | null;
	onEdit: () => void;
	onCancel: () => void;
}

let {
	anchorId,
	isFocused,
	scheduledAction,
	busy = false,
	error = null,
	onEdit,
	onCancel,
}: Props = $props();
</script>

<section
	id={anchorId}
	class="scheduled-action-section"
	class:is-focused={isFocused}
	data-anchor-id={anchorId}
	data-focused={isFocused ? "true" : "false"}
	data-section="scheduled-action"
	tabindex="-1"
>
	<div class="scheduled-action-header">
		<div>
			<p class="scheduled-eyebrow">Scheduled action</p>
			<h3>{scheduledAction.actionLabel}</h3>
			<p class="scheduled-copy">
				Scheduled for {formatLocalDateTime24Hour(scheduledAction.nextRunAt)} · {formatUtcDateTime24Hour(
					scheduledAction.nextRunAt,
				)}
			</p>
		</div>
		<div class="scheduled-actions">
			<button type="button" class="secondary-button" data-pressable="true" disabled={busy} onclick={onEdit}>
				Edit
			</button>
			<button type="button" class="secondary-button" data-pressable="true" disabled={busy} onclick={onCancel}>
				{busy ? "Canceling…" : "Cancel"}
			</button>
		</div>
	</div>

	{#if scheduledAction.status === "blocked" && scheduledAction.blockedReason}
		<p class="scheduled-error" role="alert">
			Blocked — {scheduledAction.blockedReason.summary}. Edit the model selection or restore model
			availability.
		</p>
	{/if}

	{#if scheduledAction.action.preview}
		<p class="scheduled-meta" data-section="scheduled-action-preview">
			{scheduledAction.action.preview.kind === "terminal"
				? "Preview · Completes this process"
				: `Preview · ${scheduledAction.action.preview.description}`}
		</p>
	{/if}
	{#if scheduledAction.nextTurnModelProfileId}
		<p class="scheduled-meta">Model · {scheduledAction.nextTurnModelProfileId}</p>
	{/if}
	<p class="scheduled-lock-copy">
		{scheduledAction.status === "blocked"
			? "This process remains locked while the scheduled action is blocked or until it is canceled."
			: "This process is locked until the scheduled action runs or is canceled."}
		Retry and abort are still available from the top bar.
	</p>

	{#if error}
		<p class="scheduled-error" role="alert">{error}</p>
	{/if}
</section>

<style>
	.scheduled-action-section {
		padding: 18px 20px;
		margin-inline-start: var(--chronicle-secondary-indent, clamp(24px, 4vw, 48px));
		border: 1px solid color-mix(in srgb, var(--chronicle-accent) 34%, var(--chronicle-border) 66%);
		border-radius: 18px;
		background: color-mix(in srgb, var(--chronicle-accent) 6%, var(--chronicle-card-surface));
		display: grid;
		gap: 10px;
	}

	.scheduled-action-section.is-focused {
		border-color: color-mix(in srgb, var(--chronicle-accent) 52%, var(--chronicle-border) 48%);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--chronicle-accent) 24%, transparent 76%);
	}

	.scheduled-action-header {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		align-items: start;
	}

	.scheduled-eyebrow {
		margin: 0 0 4px;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--chronicle-text-faint);
	}

	.scheduled-action-header h3 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 18px;
		line-height: 1.25;
		font-weight: 620;
		color: var(--chronicle-text);
	}

	.scheduled-copy,
	.scheduled-meta,
	.scheduled-lock-copy,
	.scheduled-error {
		margin: 0;
		font-size: 14px;
		line-height: 1.55;
	}

	.scheduled-copy,
	.scheduled-meta,
	.scheduled-lock-copy {
		color: var(--chronicle-text-muted);
	}

	.scheduled-actions {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.secondary-button {
		min-height: 40px;
		padding: 0 14px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border-strong) 84%, white 16%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 94%, white 6%);
		color: var(--chronicle-text);
		font: inherit;
		font-size: 14px;
		font-weight: 620;
		cursor: pointer;
	}

	.secondary-button:hover:not(:disabled) {
		transform: translateY(-1px);
	}

	.secondary-button:disabled {
		opacity: 0.62;
		cursor: default;
		transform: none;
	}

	.scheduled-error {
		padding: 12px 14px;
		border-radius: 14px;
		border: 1px solid color-mix(in srgb, var(--chronicle-danger) 40%, var(--chronicle-border) 60%);
		background: color-mix(in srgb, var(--chronicle-danger) 8%, var(--chronicle-card-surface));
		color: var(--chronicle-danger-text);
	}

	@media (max-width: 720px) {
		.scheduled-action-section {
			margin-inline-start: 0;
		}

		.scheduled-action-header {
			flex-direction: column;
		}

		.scheduled-actions,
		.secondary-button {
			width: 100%;
		}
	}
</style>
