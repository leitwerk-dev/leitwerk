<script lang="ts">
let { title, onClick }: { title: string; onClick: () => void } = $props();
</script>

<button type="button" class="turn-details-button" data-action="open-turn-details" aria-label={`Turn details for ${title}`} onclick={onClick}>Turn details</button>

<style>
	.turn-details-button { min-height: 28px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--chronicle-text-muted); font: inherit; font-size: var(--type-caption); font-weight: 600; white-space: nowrap; cursor: pointer; }
	.turn-details-button:hover { color: var(--chronicle-accent); text-decoration: underline; text-underline-offset: 3px; }
	.turn-details-button:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 3px; }
</style>
