<script lang="ts">
import type { ProcessStartupSummary, StartupAttemptStepSummary } from "@leitwerk-dev/protocol";
import type { ChronicleChecklistStep, ChronicleChecklistTone } from "../lib/chronicle-checklist.js";
import ChronicleChecklist from "./ChronicleChecklist.svelte";

interface Props {
	startup: ProcessStartupSummary;
}

let { startup }: Props = $props();

const statusLabels: Record<StartupAttemptStepSummary["status"], string> = {
	pending: "Pending",
	in_progress: "In progress",
	completed: "Completed",
	failed: "Failed",
	superseded: "Superseded",
};
const statusTones: Record<StartupAttemptStepSummary["status"], ChronicleChecklistTone> = {
	pending: "pending",
	in_progress: "active",
	completed: "success",
	failed: "failed",
	superseded: "neutral",
};

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

function checklistSteps(steps: readonly StartupAttemptStepSummary[]): ChronicleChecklistStep[] {
	return steps.map((step) => ({
		id: step.id,
		label: step.label,
		statusLabel: statusLabels[step.status],
		tone: statusTones[step.status],
		sourceStatus: step.status,
	}));
}
</script>

{#if startup.attempts.length > 0}
	<section class="startup-history" aria-label="Process startup history" data-section="startup-history">
		{#each startup.attempts as attempt (attempt.startRecordId)}
			<div data-startup-attempt={attempt.startRecordId} data-status={attempt.status}>
				<ChronicleChecklist
					title={heading(attempt.status)}
					steps={checklistSteps(attempt.steps)}
					meta={durationLabel(attempt.durationMs)}
					summary={attempt.summary}
					headingLevel="h3"
					section="startup-attempt"
				/>
			</div>
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
</style>
