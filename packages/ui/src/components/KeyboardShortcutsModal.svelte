<script lang="ts">
import type { KeyboardShortcutItem } from "../lib/keyboard-shortcuts-help.js";
import ModalShell from "./ModalShell.svelte";

interface Props {
	open: boolean;
	title: string;
	description?: string | null;
	items: readonly KeyboardShortcutItem[];
	onClose: () => void;
}

let { open, title, description = null, items, onClose }: Props = $props();
</script>

<ModalShell
	{open}
	titleId="keyboard-shortcuts-title"
	closeLabel="Close keyboard shortcuts"
	{onClose}
	dataSection="keyboard-shortcuts-overlay"
	panelId="keyboard-shortcuts-modal"
	width="min(100% - 32px, 320px)"
	maxHeight="calc(100vh - 32px)"
>
	<header class="shortcut-header">
		<h2 id="keyboard-shortcuts-title">{title}</h2>
		{#if description}<p>{description}</p>{/if}
	</header>

	<ul class="shortcut-list">
		{#each items as item (`${item.label}-${item.keys.join("-")}`)}
			<li class="shortcut-row">
				<div class="shortcut-keys" aria-hidden="true">
					{#each item.keys as key (`${item.label}-${key}`)}<kbd>{key}</kbd>{/each}
				</div>
				<span>{item.label}</span>
			</li>
		{/each}
	</ul>
</ModalShell>

<style>
	.shortcut-header { display: grid; gap: 8px; margin-right: 34px; }
	.shortcut-header h2 { margin: 0; font-size: var(--type-title-md); line-height: 1.1; }
	.shortcut-header p { margin: 0; color: var(--chronicle-text-muted); font-size: var(--type-body-sm); line-height: 1.55; }
	.shortcut-list { margin: 0; padding: 0; overflow-y: auto; list-style: none; display: grid; gap: 8px; }
	.shortcut-row { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: center; padding: 10px 12px; border-radius: var(--radius-md); background: var(--chronicle-panel-muted); }
	.shortcut-keys { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
	.shortcut-row span { font-size: var(--type-body); line-height: 1.45; color: var(--chronicle-text); }
	kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 24px; padding: 0 7px; border: 1px solid var(--chronicle-border-strong); border-radius: 8px; background: var(--chronicle-bg); font-family: var(--font-mono); font-size: var(--type-caption); font-weight: 700; color: var(--chronicle-text); }
</style>
