<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	kind: "process-info" | "reasoning";
	closeLabel: string;
	onClose: () => void;
	children: Snippet;
}

let { kind, closeLabel, onClose, children }: Props = $props();
</script>

<div class="process-detail-overlay-frame" data-section="process-detail-overlay-frame" data-overlay-kind={kind}>
	<button
		type="button"
		class="process-detail-overlay-backdrop"
		aria-label={closeLabel}
		onclick={onClose}
	></button>
	<div class="process-detail-overlay-panel">
		{@render children()}
	</div>
</div>

<style>
	.process-detail-overlay-frame {
		position: absolute;
		inset: 0;
		display: grid;
		min-height: 0;
		z-index: 30;
		pointer-events: none;
	}

	.process-detail-overlay-backdrop {
		position: absolute;
		inset: 0;
		border: 0;
		background: color-mix(in srgb, var(--chronicle-bg) 18%, transparent 82%);
		cursor: default;
		pointer-events: auto;
	}

	.process-detail-overlay-panel {
		position: absolute;
		inset: 0;
		display: grid;
		min-height: 0;
		z-index: 1;
		pointer-events: auto;
	}

	.process-detail-overlay-panel > :global(*) {
		height: 100%;
		min-height: 0;
	}
</style>
