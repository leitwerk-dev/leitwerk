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
		background: color-mix(in srgb, var(--chronicle-accent) 72%, white 28%);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--chronicle-accent) 24%, white 76%);
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

	.live-pulse::after {
		content: "";
		position: absolute;
		inset: -5px;
		border-radius: inherit;
		background: color-mix(in srgb, var(--chronicle-accent) 22%, transparent 78%);
		animation: -global-live-pulse-wave 1.7s var(--ease-out-quint, cubic-bezier(0.22, 1, 0.36, 1)) infinite;
	}

	@keyframes -global-live-pulse-wave {
		0% {
			transform: scale(0.55);
			opacity: 0.78;
		}

		70% {
			transform: scale(1.35);
			opacity: 0;
		}

		100% {
			transform: scale(1.35);
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.live-pulse::after {
			animation: none;
			opacity: 0.25;
			transform: scale(1);
		}
	}
</style>
