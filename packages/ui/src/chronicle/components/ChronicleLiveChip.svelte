<script lang="ts">
interface Props {
	label: string;
	size?: "sm" | "md";
}

let { label, size = "md" }: Props = $props();
</script>

<span class="live-chip" data-size={size}>
	<span class="live-pulse" aria-hidden="true"></span>
	{label}
</span>

<style>
	.live-chip {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--chronicle-accent) 24%, var(--chronicle-border) 76%);
		background: color-mix(in srgb, white 92%, var(--chronicle-accent-soft) 8%);
		color: color-mix(in srgb, var(--chronicle-text) 66%, var(--chronicle-accent) 34%);
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.live-chip[data-size="sm"] {
		min-height: 28px;
		padding: 0 10px;
		font-size: 11px;
	}

	.live-chip[data-size="md"] {
		min-height: 32px;
		padding: 0 12px;
		font-size: 12px;
		font-weight: 620;
		letter-spacing: normal;
		text-transform: none;
	}

	.live-pulse {
		position: relative;
		display: inline-flex;
		border-radius: 999px;
		background: var(--chronicle-text-muted);
		flex-shrink: 0;
	}

	.live-chip[data-size="sm"] .live-pulse {
		width: 9px;
		height: 9px;
	}

	.live-chip[data-size="md"] .live-pulse {
		width: 10px;
		height: 10px;
	}

</style>
