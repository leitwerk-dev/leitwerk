<script lang="ts">
import type { ProcessStartupSummary } from "@leitwerk-dev/protocol";
import ProgressChecklist from "../../components/ProgressChecklist.svelte";

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
			<article data-status={attempt.status}>
				<ProgressChecklist
					title={heading(attempt.status)}
					headingLevel="h3"
					description={durationLabel(attempt.durationMs)}
					summary={attempt.summary}
					steps={attempt.steps}
				/>
			</article>
		{/each}
	</section>
{/if}

<style>
	.startup-history { display: grid; gap: var(--space-md); padding-bottom: var(--space-lg); border-bottom: 1px solid var(--chronicle-border); }
</style>
