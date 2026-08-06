<script lang="ts">
import type { UiLauncherSummary } from "../lib/api.js";
import ProcessFlowDiagram from "./ProcessFlowDiagram.svelte";

interface Props {
	launcher: UiLauncherSummary;
	tabindexValue?: number;
	onSelect: (launcherId: string) => void;
	onKeydown?: (event: KeyboardEvent) => void;
}

let { launcher, tabindexValue = 0, onSelect, onKeydown }: Props = $props();

const title = $derived(launcher.card.title ?? launcher.label);
const description = $derived(launcher.card.description ?? launcher.description);
</script>

<button
	type="button"
	class="process-card"
	data-process-card-id={launcher.id}
	data-launcher-id={launcher.id}
	data-pressable="true"
	tabindex={tabindexValue}
	aria-label={`${title}. ${description}`}
	onclick={() => onSelect(launcher.id)}
	onkeydown={onKeydown}
>
	<span class="card-main">
		<span class="card-title">{title}</span>
		<span class="card-description">{description}</span>
	</span>
	<span class="card-flow">
		<ProcessFlowDiagram {launcher} compact={true} />
	</span>
</button>

<style>
	.process-card {
		display: grid;
		grid-template-rows: auto 1fr;
		gap: var(--space-md);
		width: 100%;
		min-height: 240px;
		padding: clamp(18px, 2.4vw, 24px);
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 78%, transparent 22%);
		border-radius: 24px;
		background:
			linear-gradient(145deg, color-mix(in srgb, var(--chronicle-card-surface) 94%, white 6%), color-mix(in srgb, var(--chronicle-panel-muted) 88%, transparent 12%));
		box-shadow: 0 18px 42px color-mix(in srgb, var(--chronicle-text) 7%, transparent 93%);
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition:
			transform 140ms ease,
			border-color 140ms ease,
			box-shadow 140ms ease;
	}

	.process-card:hover,
	.process-card:focus-visible {
		transform: translateY(-2px);
		border-color: color-mix(in srgb, var(--chronicle-accent) 32%, var(--chronicle-border) 68%);
		box-shadow: 0 24px 52px color-mix(in srgb, var(--chronicle-accent) 13%, transparent 87%);
		outline: none;
	}

	.process-card:focus-visible {
		box-shadow:
			0 0 0 3px color-mix(in srgb, var(--chronicle-accent) 24%, transparent 76%),
			0 24px 52px color-mix(in srgb, var(--chronicle-accent) 13%, transparent 87%);
	}

	.card-main {
		display: grid;
		gap: var(--space-sm);
	}

	.card-title {
		font-family: var(--font-display);
		font-size: clamp(1.25rem, 1.05rem + 0.55vw, 1.65rem);
		font-weight: 680;
		line-height: 1.08;
		color: var(--chronicle-text);
	}

	.card-description {
		font-size: 0.95rem;
		line-height: 1.62;
		color: color-mix(in srgb, var(--chronicle-text-muted) 90%, var(--chronicle-text) 10%);
	}

	.card-flow {
		align-self: end;
		min-width: 0;
	}

</style>
