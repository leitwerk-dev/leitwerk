<script lang="ts">
import type {
	ChronicleChecklistLink,
	ChronicleChecklistStep,
	ChronicleChecklistTone,
} from "../lib/chronicle-checklist.js";

interface Props {
	title: string;
	steps: readonly ChronicleChecklistStep[];
	links?: readonly ChronicleChecklistLink[];
	meta?: string | null;
	summary?: string | null;
	headingLevel?: "h3" | "h4";
	section?: string;
	ariaLive?: "off" | "polite" | "assertive";
}

let {
	title,
	steps,
	links = [],
	meta = null,
	summary = null,
	headingLevel = "h4",
	section,
	ariaLive,
}: Props = $props();

const headingId = $props.id();
const statusMarks: Record<ChronicleChecklistTone, string> = {
	pending: "○",
	active: "◐",
	success: "✓",
	failed: "×",
	neutral: "–",
};
</script>

<section
	class="chronicle-checklist"
	data-component="chronicle-checklist"
	data-section={section}
	aria-labelledby={headingId}
>
	<header>
		<svelte:element this={headingLevel} id={headingId}>{title}</svelte:element>
		{#if meta}<p class="checklist-meta">{meta}</p>{/if}
	</header>
	{#if summary}<p class="checklist-summary">{summary}</p>{/if}
	<ol aria-live={ariaLive}>
		{#each steps as step (step.id)}
			<li
				data-checklist-step={step.id}
				data-checklist-status={step.tone}
				data-progress-step={step.id}
				data-progress-status={step.sourceStatus}
				data-status={step.sourceStatus}
			>
				<span class="status-mark" aria-hidden="true">{statusMarks[step.tone]}</span>
				<span class="step-copy">
					<span class="step-label">{step.label}</span>
					{#if step.detail}<span class="step-detail">{step.detail}</span>{/if}
				</span>
				<span class="status-label">{step.statusLabel}</span>
			</li>
		{/each}
	</ol>
	{#if links.length > 0}
		<div class="created-changes">
			<h5>Created changes</h5>
			<ul>
				{#each links as link (link.id)}
					<li>
						<a href={link.url} target="_blank" rel="noreferrer">
							{link.label}<span class="external" aria-hidden="true">↗</span>
						</a>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>

<style>
	.chronicle-checklist {
		display: grid;
		gap: var(--space-md);
		min-width: 0;
		padding: var(--space-md);
		border: 1px solid var(--chronicle-border);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--chronicle-panel-muted) 72%, white 28%);
	}

	header {
		display: grid;
		gap: 2px;
	}

	h3,
	h4,
	h5,
	p {
		margin: 0;
		color: var(--chronicle-text);
	}

	h3,
	h4 {
		font-size: var(--type-body);
		font-weight: 700;
	}

	h5 {
		font-size: var(--type-body-sm);
		font-weight: 700;
	}

	.checklist-meta,
	.step-detail,
	.status-label {
		color: var(--chronicle-text-muted);
		font-size: var(--type-body-sm);
	}

	.checklist-summary {
		max-width: 70ch;
		color: var(--chronicle-danger-text);
	}

	ol,
	ul {
		display: grid;
		gap: var(--space-sm);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	ol > li {
		display: grid;
		grid-template-columns: 1.25rem minmax(0, 1fr) auto;
		gap: var(--space-sm);
		align-items: start;
		min-width: 0;
	}

	.status-mark {
		display: grid;
		place-items: center;
		width: 1.25rem;
		height: 1.25rem;
		color: var(--chronicle-text-muted);
		font-weight: 800;
	}

	[data-checklist-status="success"] .status-mark,
	[data-checklist-status="success"] .status-label {
		color: var(--chronicle-success);
	}

	[data-checklist-status="active"] .status-mark,
	[data-checklist-status="active"] .status-label {
		color: var(--chronicle-accent);
	}

	[data-checklist-status="failed"] .status-mark,
	[data-checklist-status="failed"] .status-label {
		color: var(--chronicle-danger);
	}

	.step-copy {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.step-label {
		min-width: 0;
		color: var(--chronicle-text);
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.step-detail {
		overflow-wrap: anywhere;
	}

	.status-label {
		white-space: nowrap;
	}

	.created-changes {
		display: grid;
		gap: var(--space-sm);
		padding-top: var(--space-sm);
		border-top: 1px solid var(--chronicle-border);
	}

	.created-changes ul {
		display: flex;
		flex-wrap: wrap;
	}

	a {
		color: var(--chronicle-link);
		font-weight: 600;
		overflow-wrap: anywhere;
		text-decoration-thickness: 1px;
		text-underline-offset: 3px;
	}

	a:focus-visible {
		border-radius: 2px;
		outline: 2px solid var(--chronicle-accent);
		outline-offset: 3px;
	}

	.external {
		margin-inline-start: 0.3em;
	}

	@media (max-width: 600px) {
		ol > li {
			grid-template-columns: 1.25rem minmax(0, 1fr);
		}

		.status-label {
			grid-column: 2;
		}
	}
</style>
