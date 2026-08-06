<script lang="ts" generics="P extends object">
import type { Component } from "svelte";

interface Props {
	load: Promise<{ default: Component<P> }>;
	props: P;
}

let { load, props }: Props = $props();
</script>

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

<style>
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
</style>
