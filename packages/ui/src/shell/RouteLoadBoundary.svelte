<script lang="ts" generics="P extends object">
import type { Component } from "svelte";

interface Props {
	load: Promise<{ default: Component<P> }>;
	props: P;
	viewportMode?: "page" | "workspace";
}

let { load, props, viewportMode = "page" }: Props = $props();
</script>

<div class="route-viewport" data-role="route-viewport" data-mode={viewportMode}>
	{#await load}
		<div class="route-status" role="status">Loading view…</div>
	{:then loaded}
		{@const RouteComponent = loaded.default}
		<RouteComponent {...props} />
	{:catch}
		<div class="route-status route-error" role="alert">
			<p>This view couldn’t be loaded.</p>
			<button type="button" onclick={() => window.location.reload()}>Reload application</button>
		</div>
	{/await}
</div>

<style>
	.route-viewport {
		flex: 1 1 auto;
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
	}

	.route-viewport[data-mode="page"] {
		overflow-y: auto;
		overscroll-behavior-y: contain;
	}

	.route-viewport[data-mode="workspace"] {
		overflow: hidden;
	}

	.route-viewport > :global(*) {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
	}

	.route-status {
		display: grid;
		place-content: center;
		gap: var(--space-sm);
		min-height: 12rem;
		color: var(--text-muted);
		text-align: center;
	}

	.route-error button {
		min-height: 44px;
		padding: 0 var(--space-md);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface-raised);
		color: var(--text-primary);
		cursor: pointer;
	}

	@media (max-width: 960px) {
		.route-viewport[data-mode="page"] {
			height: auto;
			overflow-y: visible;
			overscroll-behavior-y: auto;
		}
	}
</style>
