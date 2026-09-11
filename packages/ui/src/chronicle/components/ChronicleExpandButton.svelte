<script lang="ts">
interface Props {
	expanded: boolean;
	expandedLabel?: string;
	collapsedLabel?: string;
	class?: string;
	dataAction?: string;
	dataPressable?: boolean;
	ariaLabel?: string;
	controls?: string;
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
	controls,
	onClick,
}: Props = $props();
</script>

<button
	type="button"
	class="ui-button chronicle-expand-button {className}"
	data-variant="quiet"
	data-action={dataAction}
	data-pressable={dataPressable ? "true" : undefined}
	aria-label={ariaLabel}
	aria-expanded={controls ? expanded : undefined}
	aria-controls={controls}
	onclick={onClick}
>
	{expanded ? expandedLabel : collapsedLabel}
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true" class:expanded><path d="m6 9 6 6 6-6" /></svg>
</button>

<style>
	.chronicle-expand-button { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 3px 0; border: 0; border-radius: 4px; background: transparent; color: var(--chronicle-accent); font-size: var(--type-body-sm); font-weight: 500; box-shadow: none; }
	.chronicle-expand-button:hover { background: transparent; text-decoration: underline; text-underline-offset: 3px; }
	svg { flex-shrink: 0; }
	svg.expanded { transform: rotate(180deg); }
</style>
