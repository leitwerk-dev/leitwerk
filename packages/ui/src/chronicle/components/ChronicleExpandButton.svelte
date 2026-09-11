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
	class="ui-button chronicle-expand-button {className}"
	data-variant="quiet"
	data-action={dataAction}
	data-pressable={dataPressable ? "true" : undefined}
	aria-label={ariaLabel}
	onclick={onClick}
>
	{expanded ? expandedLabel : collapsedLabel}
</button>
