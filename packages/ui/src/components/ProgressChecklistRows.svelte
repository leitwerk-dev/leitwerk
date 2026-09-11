<script module lang="ts">
export interface ChecklistStep {
	id: string;
	label: string;
	status:
		| "pending"
		| "incomplete"
		| "in_progress"
		| "completed"
		| "failed"
		| "superseded"
		| "skipped";
	detail?: string | null;
}
</script>

<script lang="ts">
let { steps }: { steps: readonly ChecklistStep[] } = $props();
const statusLabels: Record<ChecklistStep["status"], string> = {
	pending: "Pending",
	incomplete: "Incomplete",
	in_progress: "In progress",
	completed: "Complete",
	failed: "Failed",
	superseded: "Superseded",
	skipped: "Skipped",
};
</script>

<div class="checklist-rows">
	<ol aria-live="polite">
		{#each steps as step (step.id)}
			<li data-progress-step={step.id} data-progress-status={step.status}>
				<svg class="status-mark" viewBox="0 0 20 20" aria-hidden="true">
					{#if step.status === "completed"}
						<path d="m4 10 4 4 8-9" />
					{:else if step.status === "failed"}
						<path d="m5 5 10 10M15 5 5 15" />
					{:else if step.status === "superseded" || step.status === "skipped"}
						<path d="M5 10h10" />
					{:else}
						<circle cx="10" cy="10" r="6" />
						{#if step.status === "in_progress"}<path d="M10 4a6 6 0 0 1 0 12Z" fill="currentColor" />{/if}
					{/if}
				</svg>
				<span class="step-copy">
					<span class="step-label">{step.label}</span>
					{#if step.detail}<span class="step-detail">{step.detail}</span>{/if}
				</span>
				<span class="status-label">{statusLabels[step.status]}</span>
			</li>
		{/each}
	</ol>
</div>

<style>
	.checklist-rows { container-type: inline-size; min-width: 0; }
	ol { display: grid; gap: var(--space-sm); margin: 0; padding: 0; list-style: none; }
	li { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: var(--space-sm); align-items: start; }
	.status-mark { width: 20px; height: 20px; color: var(--chronicle-text-muted); fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
	[data-progress-status="completed"] .status-mark, [data-progress-status="completed"] .status-label { color: var(--chronicle-success); }
	[data-progress-status="in_progress"] .status-mark, [data-progress-status="in_progress"] .status-label { color: var(--chronicle-accent); }
	[data-progress-status="failed"] .status-mark, [data-progress-status="failed"] .status-label { color: var(--chronicle-danger); }
	.step-copy { display: grid; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
	.step-label { color: var(--chronicle-text); font-size: var(--type-body); font-weight: 600; line-height: 1.5; }
	.status-label { white-space: nowrap; }
	@container (max-width: 420px) { li { grid-template-columns: 20px minmax(0, 1fr); row-gap: 2px; } .status-label { grid-column: 2; } }
	.step-detail { color: var(--chronicle-text-muted); font-size: var(--type-body-sm); line-height: 1.5; }
	.status-label { color: var(--chronicle-text-muted); font-size: var(--type-body-sm); line-height: 1.5; }
</style>
