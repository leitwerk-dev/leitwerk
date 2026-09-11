<script lang="ts">
import type { ProcessStartupSummary } from "@leitwerk-dev/protocol";
import ElapsedTime from "../../components/ElapsedTime.svelte";
import { formatElapsedTime } from "../../lib/elapsed-time.js";
import ProgressChecklistRows from "../../components/ProgressChecklistRows.svelte";
import { formatChronicleDuration } from "../lib/formatting.js";
import ChronicleEntryHeader from "./ChronicleEntryHeader.svelte";

let { startup }: { startup: ProcessStartupSummary } = $props();
function heading(status: ProcessStartupSummary["attempts"][number]["status"]): string {
	if (status === "succeeded") return "Process startup succeeded";
	if (status === "recovered") return "Startup failed, then recovered";
	if (status === "failed") return "Process startup failed";
	if (status === "superseded") return "Startup attempt superseded";
	return "Starting process";
}
</script>

{#if startup.attempts.length > 0}
	<section class="startup-history" aria-label="Process startup history" data-section="startup-history">
		{#each startup.attempts as attempt (attempt.startRecordId)}
			{@const completed = attempt.steps.filter((step) => step.status === "completed").length}
			{@const ready = attempt.durationMs !== null && attempt.readyAt !== null ? `Worker ready in ${formatElapsedTime(attempt.durationMs)} · Model response time is separate · ` : ""}
			<details class="startup-attempt" data-status={attempt.status} open={attempt.status === "failed" || attempt.status === "starting"}>
				<summary>
					<ChronicleEntryHeader title={heading(attempt.status)} metadata={`${ready}${completed}/${attempt.steps.length} checks completed`} timestamp={attempt.startedAt} duration={formatChronicleDuration(attempt.startedAt, attempt.readyAt)}>
						{#snippet controls()}<svg class="chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>{/snippet}
					</ChronicleEntryHeader>
				</summary>
				<div class="startup-details">
					{#if attempt.summary}<p class="startup-summary">{attempt.summary}</p>{/if}
					<ProgressChecklistRows steps={attempt.steps.map((step) => ({
                        ...step,
                        timing: {
                            startedAt: step.startedAt ?? null,
                            endedAt: step.endedAt ?? null,
                            running: attempt.status === "starting" && step.status === "in_progress",
                        },
                    }))} />
                    {#if attempt.status === "starting"}
                        <p class="active-phase">Startup · <ElapsedTime startedAt={attempt.startedAt} running /></p>
                    {/if}
				</div>
			</details>
		{/each}
	</section>
{/if}

<style>
	.active-phase { margin: 0; color: var(--chronicle-accent); font-weight: 600; }
	.startup-history { display: grid; gap: 10px; }
	.startup-attempt { border: 1px solid var(--chronicle-border); border-radius: 10px; background: var(--chronicle-card-surface-strong); }
	summary { padding: 12px 14px; list-style: none; cursor: pointer; }
	summary::-webkit-details-marker { display: none; }
	summary:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 2px; border-radius: 10px; }
	summary:hover { background: var(--chronicle-panel-muted); border-radius: 10px; }
	.chevron { margin-top: 6px; color: var(--chronicle-text-muted); }
	details[open] .chevron { transform: rotate(180deg); }
	.startup-details { display: grid; gap: 10px; margin: 0 14px; padding: 12px 0; border-top: 1px solid var(--chronicle-border); }
	.startup-summary { margin: 0; color: var(--chronicle-danger-text); font-size: var(--type-body-sm); line-height: 1.5; }
	[data-status="failed"] { border-color: var(--chronicle-danger-border); background: var(--chronicle-danger-surface-soft); }
	@media (max-width: 540px) { summary { padding: 10px; } }
</style>
