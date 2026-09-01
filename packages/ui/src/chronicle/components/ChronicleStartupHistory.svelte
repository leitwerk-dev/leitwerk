<script lang="ts">
import type { ProcessStartupSummary } from "@leitwerk-dev/protocol";

interface Props {
	startup: ProcessStartupSummary;
}

let { startup }: Props = $props();

function heading(status: ProcessStartupSummary["attempts"][number]["status"]): string {
	if (status === "succeeded") return "Process startup succeeded";
	if (status === "recovered") return "Startup failed, then recovered";
	if (status === "failed") return "Process startup failed";
	if (status === "superseded") return "Startup attempt superseded";
	return "Starting process";
}

function durationLabel(durationMs: number | null): string | null {
	if (durationMs === null) return null;
	return `Worker ready in ${Math.max(0, Math.round(durationMs / 1000))}s`;
}
</script>

{#if startup.attempts.length > 0}
	<section class="startup-history" aria-label="Process startup history" data-section="startup-history">
		{#each startup.attempts as attempt (attempt.startRecordId)}
			<article class="attempt" data-status={attempt.status}>
				<header>
					<span class="status-mark" aria-hidden="true"></span>
					<div>
						<h3>{heading(attempt.status)}</h3>
						{#if durationLabel(attempt.durationMs)}
							<p class="duration">{durationLabel(attempt.durationMs)}</p>
						{/if}
					</div>
				</header>
				{#if attempt.summary}<p class="summary">{attempt.summary}</p>{/if}
				<ol>
					{#each attempt.steps as step (step.id)}
						<li data-status={step.status}>
							<span class="step-mark" aria-hidden="true"></span>
							<span>{step.label}</span>
							<span class="step-status">
								{step.status === "in_progress"
									? "In progress"
									: step.status === "superseded"
										? "Superseded"
										: step.status[0]?.toUpperCase() + step.status.slice(1)}
							</span>
						</li>
					{/each}
				</ol>
			</article>
		{/each}
	</section>
{/if}

<style>
	.startup-history {
		display: grid;
		gap: var(--space-md);
		padding-bottom: var(--space-lg);
		border-bottom: 1px solid var(--chronicle-border);
	}

	.attempt {
		display: grid;
		gap: var(--space-sm);
		padding: var(--space-md) var(--space-lg);
		border: 1px solid var(--chronicle-border);
		border-radius: var(--radius-lg);
		background: var(--chronicle-card-surface);
	}

	.attempt[data-status="failed"],
	.attempt[data-status="recovered"] {
		border-color: color-mix(in srgb, var(--chronicle-danger) 34%, var(--chronicle-border));
		background: color-mix(in srgb, var(--chronicle-danger) 6%, var(--chronicle-card-surface));
	}

	header {
		display: flex;
		gap: var(--space-sm);
		align-items: flex-start;
	}

	h3,
	p,
	ol {
		margin: 0;
	}

	h3 {
		font-size: var(--type-body-lg);
		line-height: 1.3;
	}

	.status-mark {
		flex: 0 0 auto;
		width: 10px;
		height: 10px;
		margin-top: 5px;
		border: 2px solid var(--chronicle-accent);
		border-radius: 50%;
	}

	.attempt[data-status="succeeded"] .status-mark {
		border-color: var(--chronicle-success);
		background: var(--chronicle-success);
	}

	.attempt[data-status="failed"] .status-mark,
	.attempt[data-status="recovered"] .status-mark {
		border-color: var(--chronicle-danger);
		background: var(--chronicle-danger);
	}

	.duration,
	.step-status {
		color: var(--chronicle-text-muted);
		font-size: var(--type-body-sm);
	}

	.summary {
		max-width: 70ch;
		color: var(--chronicle-danger-text);
	}

	ol {
		display: grid;
		gap: var(--space-xs);
		padding: 0;
		list-style: none;
	}

	li {
		display: grid;
		grid-template-columns: 14px minmax(0, 1fr) auto;
		gap: var(--space-sm);
		align-items: center;
		min-height: 28px;
		color: var(--chronicle-text-muted);
	}

	.step-mark {
		width: 8px;
		height: 8px;
		border: 1.5px solid currentColor;
		border-radius: 50%;
	}

	li[data-status="completed"] {
		color: var(--chronicle-text);
	}

	li[data-status="completed"] .step-mark {
		border-color: var(--chronicle-success);
		background: var(--chronicle-success);
	}

	li[data-status="failed"] {
		color: var(--chronicle-danger-text);
	}

	li[data-status="failed"] .step-mark {
		border-color: var(--chronicle-danger);
		background: var(--chronicle-danger);
	}

	@media (max-width: 560px) {
		.attempt {
			padding-inline: var(--space-md);
		}

		li {
			grid-template-columns: 14px minmax(0, 1fr);
		}

		.step-status {
			grid-column: 2;
		}
	}
</style>
