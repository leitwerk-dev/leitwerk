<script lang="ts">
import {
	EXTERNAL_LINK_CLASS,
	EXTERNAL_LINK_ICON,
	EXTERNAL_LINK_ICON_CLASS,
	type ExternalResourceType,
	externalResourceLabel,
	NEW_TAB_ANNOUNCEMENT,
	NEW_TAB_REL,
} from "../lib/external-links.js";

interface Props {
	href: string;
	label: string;
	resourceType?: ExternalResourceType;
	accessibleLabel?: string;
	className?: string;
}

let {
	href,
	label,
	resourceType = "external_resource",
	accessibleLabel = label,
	className = "",
}: Props = $props();

const resourceLabel = $derived(externalResourceLabel(resourceType));
</script>

<a
	{href}
	target="_blank"
	rel={NEW_TAB_REL}
	class={`${EXTERNAL_LINK_CLASS} ${className}`.trim()}
	aria-label={`${resourceLabel}: ${accessibleLabel} (${NEW_TAB_ANNOUNCEMENT})`}
>
	{label}<span class={EXTERNAL_LINK_ICON_CLASS} aria-hidden="true">{EXTERNAL_LINK_ICON}</span>
</a>
