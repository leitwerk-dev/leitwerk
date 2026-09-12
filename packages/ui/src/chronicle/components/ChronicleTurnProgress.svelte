<script lang="ts">
import type { TurnProgressReport } from "@leitwerk-dev/domain";
import ProgressChecklist from "../../components/ProgressChecklist.svelte";
import ProgressChecklistRows, {
	type ChecklistStep,
} from "../../components/ProgressChecklistRows.svelte";

let {
	report,
	compact = false,
	attemptStatus,
}: { report: TurnProgressReport; compact?: boolean; attemptStatus?: string } = $props();
const ended = $derived(attemptStatus !== undefined && attemptStatus !== "in_progress");
const steps = $derived<ChecklistStep[]>(
	report.steps.map((step) =>
		ended && step.status === "in_progress"
			? { ...step, status: attemptStatus === "succeeded" ? "unrecorded" : "interrupted" }
			: step,
	),
);
const hasUnfinished = $derived(ended && report.steps.some((step) => step.status === "in_progress"));
const succeeded = $derived(
	report.steps.length > 0 && report.steps.every((step) => step.status === "completed"),
);
const summary = $derived(compact ? "Workspace prepared" : `${report.title} completed`);
</script>

{#snippet createdChanges()}
	{#if report.links?.length}
		<div class="created-changes">
			<h5>Related resources</h5>
			<ul>{#each report.links as link (link.id)}<li><a href={link.url} target="_blank" rel="noreferrer">{link.label}</a></li>{/each}</ul>
		</div>
	{/if}
{/snippet}

{#if succeeded}
	<div class="progress-summary" data-section="turn-progress">
		<details>
			<summary>
				<svg class="check" width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="8" /><path d="m6 10 3 3 5-6" /></svg>
				<span>{summary}</span>
				<svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
			</summary>
			<div class="progress-details"><ProgressChecklistRows {steps} /></div>
		</details>
		{@render createdChanges()}
	</div>
{:else}
	<ProgressChecklist title={report.title} {steps} dataSection="turn-progress">{@render createdChanges()}</ProgressChecklist>
{/if}
{#if hasUnfinished}
	<details><summary>Original progress report</summary><ProgressChecklistRows steps={report.steps.map((step) => ({ ...step, status: step.status === "in_progress" ? "incomplete" : step.status, detail: step.status === "in_progress" ? ["Recorded as in progress", step.detail].filter(Boolean).join(" · ") : step.detail }))} /></details>
{/if}

<style>
	.progress-summary { min-width: 0; }
	summary { display: flex; align-items: center; gap: 7px; width: fit-content; max-width: 100%; min-height: 28px; list-style: none; color: var(--chronicle-text-muted); font-size: var(--type-body-sm); cursor: pointer; }
	summary::-webkit-details-marker { display: none; }
	summary:hover { color: var(--chronicle-text); }
	summary:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 2px; border-radius: 4px; }
	.check { color: var(--chronicle-success); flex-shrink: 0; }
	.chevron { color: var(--chronicle-text-faint); }
	details[open] .chevron { transform: rotate(180deg); }
	.progress-details { padding: 10px 0; }
	h5 { margin: 0; color: var(--chronicle-text); font-size: var(--type-body-sm); font-weight: 600; }
	.created-changes { display: grid; gap: 4px; margin-top: 6px; }
	ul { display: flex; flex-wrap: wrap; gap: var(--space-sm); margin: 0; padding: 0; list-style: none; }
	a { color: var(--chronicle-accent); font-size: var(--type-body-sm); text-decoration-thickness: 1px; text-underline-offset: 3px; }
</style>
