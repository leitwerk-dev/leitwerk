<script lang="ts">
let {
	title,
	onClick,
	kind = "turn",
}: { title: string; onClick: () => void; kind?: "turn" | "reasoning" } = $props();
const label = $derived(kind === "reasoning" ? "Show reasoning" : "Turn details");
</script>

<button type="button" class="turn-details-button" data-action={kind === "reasoning" ? "open-reasoning-details" : "open-turn-details"} aria-label={kind === "reasoning" ? label : `${label} for ${title}`} onclick={onClick}>{label}</button>

<style>
	.turn-details-button { min-height: 28px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--chronicle-text-muted); font: inherit; font-size: var(--type-caption); font-weight: 600; white-space: nowrap; cursor: pointer; }
	.turn-details-button:hover { color: var(--chronicle-accent); text-decoration: underline; text-underline-offset: 3px; }
	.turn-details-button:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 3px; }
</style>
