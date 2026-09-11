<script lang="ts">
import type { TurnProgressReport } from "@leitwerk-dev/domain";
import ProgressChecklist from "../../components/ProgressChecklist.svelte";

interface Props {
	report: TurnProgressReport;
}
let { report }: Props = $props();
</script>

<ProgressChecklist title={report.title} steps={report.steps} dataSection="turn-progress">
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
</ProgressChecklist>

<style>
	h5 { margin: 0; color: var(--chronicle-text); font-size: var(--type-body-sm); font-weight: 700; }
	.created-changes { display: grid; gap: var(--space-sm); padding-top: var(--space-sm); border-top: 1px solid var(--chronicle-border); }
	ul { display: flex; flex-wrap: wrap; gap: var(--space-sm); margin: 0; padding: 0; list-style: none; }
	a { color: var(--chronicle-link); font-weight: 600; text-decoration-thickness: 1px; text-underline-offset: 3px; }
	.external { margin-inline-start: 0.3em; }
</style>
