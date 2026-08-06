<script lang="ts">
import { onMount } from "svelte";
import type { RegisteredBrowserUiShellIndicator } from "../lib/ui-extensions.svelte.js";

interface Props {
	indicator: RegisteredBrowserUiShellIndicator;
}

let { indicator }: Props = $props();
let host: HTMLDivElement;

onMount(() => {
	const cleanup = indicator.mount(host);
	return () => {
		if (typeof cleanup === "function") {
			cleanup();
		}
	};
});
</script>

<div
	class="browser-ui-extension-indicator"
	data-extension-manifest-id={indicator.extensionManifestId}
	data-extension-indicator-id={indicator.id}
	aria-label={indicator.label}
	bind:this={host}
></div>

<style>
	.browser-ui-extension-indicator {
		display: contents;
	}
</style>
