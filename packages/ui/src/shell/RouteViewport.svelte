<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	mode?: "page" | "workspace";
	children: Snippet;
}

let { mode = "page", children }: Props = $props();
</script>

<div class="route-viewport" data-role="route-viewport" data-mode={mode}>
	{@render children()}
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

	@media (max-width: 960px) {
		.route-viewport[data-mode="page"] {
			height: auto;
			overflow-y: visible;
			overscroll-behavior-y: auto;
		}
	}
</style>
