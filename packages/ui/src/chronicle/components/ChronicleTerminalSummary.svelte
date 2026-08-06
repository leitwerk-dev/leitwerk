<script lang="ts">
import { formatRelativeTime } from "../../lib/format.js";
import {
	getProcessTerminalHeading,
	getProcessTerminalIcon,
	type ProcessTerminalStatus,
} from "../../lib/process-terminal-display.js";

function terminalStateCopy(status: ProcessTerminalStatus): string {
	return status === "completed"
		? "All planned work for this process is finished."
		: "This process was stopped before any further turns could run.";
}

interface Props {
	status: ProcessTerminalStatus;
	updatedAt: string;
	anchorId?: string | null;
	isFocused?: boolean;
}

let { status, updatedAt, anchorId = null, isFocused = false }: Props = $props();
</script>

<section
	id={anchorId ?? undefined}
	class="terminal-summary"
	class:is-completed={status === "completed"}
	class:is-aborted={status === "aborted"}
	class:is-focused={isFocused}
	data-section="chronicle-terminal-state"
	data-terminal-status={status}
	data-anchor-id={anchorId ?? undefined}
>
	<div class="terminal-copy">
		<p class="terminal-eyebrow">Final state</p>
		<div class="terminal-heading-row">
			<span class="terminal-state-mark" aria-hidden="true">{getProcessTerminalIcon(status)}</span>
			<h3>{getProcessTerminalHeading(status)} · {formatRelativeTime(updatedAt)}</h3>
		</div>
		<p class="terminal-description">{terminalStateCopy(status)}</p>
	</div>
</section>

<style>
	.terminal-summary {
		--terminal-aborted: #8a6044;
		--terminal-tone: var(--chronicle-success);

		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		padding: var(--space-lg) 0 var(--space-xl);
		border-top: 1px solid color-mix(in srgb, var(--terminal-tone) 34%, var(--chronicle-border) 66%);
		border-bottom: 1px solid color-mix(in srgb, var(--terminal-tone) 12%, transparent 88%);
		background: transparent;
		scroll-margin-top: var(--space-xl);
	}

	.terminal-summary.is-focused {
		border-top-color: color-mix(in srgb, var(--terminal-tone) 72%, var(--chronicle-accent) 28%);
		box-shadow: inset 0 1px 0 color-mix(in srgb, var(--chronicle-accent) 14%, transparent 86%);
	}

	.terminal-summary.is-aborted {
		--terminal-tone: var(--terminal-aborted);
	}

	.terminal-copy {
		display: flex;
		flex-direction: column;
		gap: var(--space-2xs);
		min-width: 0;
	}

	.terminal-eyebrow {
		margin: 0;
		font-size: var(--type-label);
		font-weight: 700;
		letter-spacing: var(--tracking-label);
		line-height: 1.4;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--terminal-tone) 72%, var(--chronicle-text) 28%);
	}

	.terminal-heading-row {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		min-width: 0;
	}

	.terminal-state-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 24px;
		height: 24px;
		border: 1px solid color-mix(in srgb, var(--terminal-tone) 40%, var(--chronicle-border) 60%);
		border-radius: 999px;
		background: color-mix(in srgb, white 90%, var(--terminal-tone) 10%);
		color: color-mix(in srgb, var(--terminal-tone) 78%, var(--chronicle-text) 22%);
		font-size: 13px;
		font-weight: 700;
		line-height: 1;
	}

	.terminal-copy h3 {
		margin: 0;
		font-family: var(--font-display);
		font-size: var(--type-title-md);
		line-height: 1.18;
		letter-spacing: -0.01em;
		font-weight: 650;
		color: var(--chronicle-text);
	}

	.terminal-description {
		margin: 0;
		max-width: 66ch;
		font-size: var(--type-body);
		line-height: 1.55;
		color: var(--chronicle-text-muted);
	}
</style>
