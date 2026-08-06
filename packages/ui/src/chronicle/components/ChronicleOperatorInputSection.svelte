<script lang="ts">
import { formatRelativeTime } from "../../lib/format";
import type { ChronicleOperatorInputItem } from "../lib/chronicle-projection.js";
import ChronicleMarkdown from "./ChronicleMarkdown.svelte";
import ChronicleSectionHeader from "./ChronicleSectionHeader.svelte";

interface Props {
	section: ChronicleOperatorInputItem;
}

let { section }: Props = $props();
</script>

<section
	class="operator-input"
	data-section="operator-input"
	data-input-id={section.inputId}
	data-input-source={section.source}
>
	<ChronicleSectionHeader label={section.sourceLabel} meta={formatRelativeTime(section.receivedAt)} />

	<ChronicleMarkdown markdown={section.bodyMarkdown} className="operator-input-markdown" />
</section>

<style>
	.operator-input {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 14px 0 16px;
		margin-inline-start: var(--chronicle-secondary-indent, clamp(24px, 4vw, 48px));
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 82%, white 18%);
		background: transparent;
	}

	@media (max-width: 720px) {
		.operator-input {
			margin-inline-start: 0;
		}
	}
</style>
