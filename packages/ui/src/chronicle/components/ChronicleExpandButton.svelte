<script lang="ts">
interface Props {
	expanded: boolean;
	expandedLabel?: string;
	collapsedLabel?: string;
	class?: string;
	dataAction?: string;
	dataPressable?: boolean;
	ariaLabel?: string;
	onClick?: (e: MouseEvent) => void;
}

let {
	expanded,
	expandedLabel = "Show less",
	collapsedLabel = "Show details",
	class: className = "",
	dataAction,
	dataPressable = false,
	ariaLabel,
	onClick,
}: Props = $props();
</script>

<button
	type="button"
	class="chronicle-expand-button {className}"
	data-action={dataAction}
	data-pressable={dataPressable ? "true" : undefined}
	aria-label={ariaLabel}
	onclick={onClick}
>
	{expanded ? expandedLabel : collapsedLabel}
</button>

<style>
	.chronicle-expand-button {
		min-height: 32px;
		padding: 0 10px;
		border: 1px solid transparent;
		border-radius: 999px;
		background: transparent;
		color: color-mix(in srgb, var(--chronicle-accent) 62%, var(--chronicle-text) 38%);
		font: inherit;
		font-size: 12px;
		font-weight: 640;
		cursor: pointer;
		transition:
			transform var(--duration-fast, 140ms) var(--ease-out-quart, cubic-bezier(0.25, 1, 0.5, 1)),
			background var(--duration-fast, 140ms) var(--ease-out-quart, cubic-bezier(0.25, 1, 0.5, 1)),
			border-color var(--duration-fast, 140ms) var(--ease-out-quart, cubic-bezier(0.25, 1, 0.5, 1)),
			color var(--duration-fast, 140ms) var(--ease-out-quart, cubic-bezier(0.25, 1, 0.5, 1));
	}

	.chronicle-expand-button:hover {
		transform: translateY(-1px);
		border-color: color-mix(in srgb, var(--chronicle-accent) 18%, transparent 82%);
		background: color-mix(in srgb, var(--chronicle-accent-soft) 56%, transparent 44%);
		color: color-mix(in srgb, var(--chronicle-accent) 76%, var(--chronicle-text) 24%);
	}

	.chronicle-expand-button:active {
		transform: translateY(0);
	}

	.chronicle-expand-button:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--chronicle-accent) 72%, white 28%);
		outline-offset: 2px;
	}
</style>
