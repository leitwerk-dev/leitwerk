<script lang="ts">
import type { Snippet } from "svelte";

import ProgressChecklistRows, { type ChecklistStep } from "./ProgressChecklistRows.svelte";

interface Props {
	title: string;
	steps: readonly ChecklistStep[];
	headingLevel?: "h3" | "h4";
	description?: string | null;
	summary?: string | null;
	dataSection?: string;
	children?: Snippet;
}

let {
	title,
	steps,
	headingLevel = "h4",
	description,
	summary,
	dataSection,
	children,
}: Props = $props();
const titleId = $props.id();
</script>

<section class="progress-checklist" data-section={dataSection} aria-labelledby={titleId}>
	<header>
		<svelte:element this={headingLevel} id={titleId}>{title}</svelte:element>
		{#if description}<p class="description">{description}</p>{/if}
	</header>
	{#if summary}<p class="summary">{summary}</p>{/if}
	<ProgressChecklistRows {steps} />
	{#if children}{@render children()}{/if}
</section>

<style>
	.progress-checklist { display: grid; gap: var(--space-md); min-width: 0; padding: var(--space-md); border: 1px solid var(--chronicle-border); border-radius: var(--radius-md); background: color-mix(in srgb, var(--chronicle-panel-muted) 72%, white 28%); }
	header { display: grid; gap: var(--space-2xs); }
	header :global(h3), header :global(h4) { margin: 0; color: var(--chronicle-text); font-size: var(--type-body); font-weight: 700; line-height: 1.5; }
	p { margin: 0; }
	.description { color: var(--chronicle-text-muted); font-size: var(--type-body-sm); line-height: 1.5; }
	.summary { max-width: 70ch; color: var(--chronicle-danger-text); font-size: var(--type-body); line-height: 1.5; overflow-wrap: anywhere; }

</style>
