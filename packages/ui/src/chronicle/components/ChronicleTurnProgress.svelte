<script lang="ts">
import type { TurnProgressReport, TurnProgressStepStatus } from "@leitwerk-dev/domain";

interface Props {
	report: TurnProgressReport;
}
let { report }: Props = $props();
const componentId = $props.id();
const titleId = `${componentId}-title`;

const statusLabels: Record<TurnProgressStepStatus, string> = {
	incomplete: "Incomplete",
	in_progress: "In progress",
	completed: "Complete",
	failed: "Failed",
};
const statusMarks: Record<TurnProgressStepStatus, string> = {
	incomplete: "○",
	in_progress: "◐",
	completed: "✓",
	failed: "×",
};
</script>

<section class="progress-report" data-section="turn-progress" aria-labelledby={titleId}>
	<h4 id={titleId}>{report.title}</h4>
	<ol aria-live="polite">
		{#each report.steps as step (step.id)}
			<li data-progress-step={step.id} data-progress-status={step.status}>
				<span class="status-mark" aria-hidden="true">{statusMarks[step.status]}</span>
				<span class="step-copy">
					<span class="step-label">{step.label}</span>
					{#if step.detail}<span class="step-detail">{step.detail}</span>{/if}
				</span>
				<span class="status-label">{statusLabels[step.status]}</span>
			</li>
		{/each}
	</ol>
	{#if report.links?.length}
		<div class="created-changes">
			<h5>Created changes</h5>
			<ul>
				{#each report.links as link (link.id)}
					<li><a href={link.url} target="_blank" rel="noreferrer">{link.label}<span class="external" aria-hidden="true">↗</span></a></li>
				{/each}
			</ul>
		</div>
	{/if}
</section>

<style>
.progress-report { display: grid; gap: var(--space-md); padding: var(--space-md); border: 1px solid var(--chronicle-border); border-radius: var(--radius-md); background: color-mix(in srgb, var(--chronicle-panel-muted) 72%, white 28%); }
h4, h5 { margin: 0; color: var(--chronicle-text); }
h4 { font-size: var(--type-body); font-weight: 700; }
h5 { font-size: var(--type-body-sm); font-weight: 700; }
ol, ul { display: grid; gap: var(--space-sm); margin: 0; padding: 0; list-style: none; }
ol li { display: grid; grid-template-columns: 1.25rem minmax(0, 1fr) auto; gap: var(--space-sm); align-items: start; }
.status-mark { display: grid; place-items: center; width: 1.25rem; height: 1.25rem; color: var(--chronicle-text-muted); font-weight: 800; }
[data-progress-status="completed"] .status-mark, [data-progress-status="completed"] .status-label { color: var(--chronicle-success); }
[data-progress-status="in_progress"] .status-mark, [data-progress-status="in_progress"] .status-label { color: var(--chronicle-accent); }
[data-progress-status="failed"] .status-mark, [data-progress-status="failed"] .status-label { color: var(--chronicle-danger); }
.step-copy { display: grid; gap: 2px; min-width: 0; }
.step-label { color: var(--chronicle-text); font-weight: 600; }
.step-detail, .status-label { color: var(--chronicle-text-muted); font-size: var(--type-body-sm); }
.status-label { white-space: nowrap; }
.created-changes { display: grid; gap: var(--space-sm); padding-top: var(--space-sm); border-top: 1px solid var(--chronicle-border); }
.created-changes ul { display: flex; flex-wrap: wrap; }
a { color: var(--chronicle-link); font-weight: 600; text-decoration-thickness: 1px; text-underline-offset: 3px; }
.external { margin-inline-start: 0.3em; }
@media (max-width: 600px) { ol li { grid-template-columns: 1.25rem minmax(0, 1fr); } .status-label { grid-column: 2; } }
</style>
