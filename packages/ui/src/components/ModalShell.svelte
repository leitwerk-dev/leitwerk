<script lang="ts">
import type { Snippet } from "svelte";
import type { Attachment } from "svelte/attachments";

interface Props {
	open: boolean;
	titleId: string;
	closeLabel: string;
	onClose: () => void;
	children: Snippet;
	dataSection?: string;
	panelId?: string;
	width?: string;
	maxHeight?: string;
	presentation?: "default" | "bottom-sheet";
	initialFocus?: string;
	returnFocus?: string;
}

let {
	open,
	titleId,
	closeLabel,
	onClose,
	children,
	dataSection,
	panelId,
	width = "min(100% - 32px, 600px)",
	maxHeight = "85vh",
	presentation = "default",
	initialFocus,
	returnFocus,
}: Props = $props();

const showModal: Attachment<HTMLDialogElement> = (dialog) => {
	const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	const handleCancel = (event: Event) => {
		event.preventDefault();
		onClose();
	};
	const handleKeydown = (event: KeyboardEvent) => {
		if (event.key !== "Tab") return;
		const focusable = [
			...dialog.querySelectorAll<HTMLElement>(
				"button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
			),
		].filter((element) => element.getClientRects().length > 0);
		const first = focusable[0];
		const last = focusable.at(-1);
		if (!first || !last) {
			event.preventDefault();
			dialog.focus();
		} else if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};
	dialog.addEventListener("cancel", handleCancel);
	dialog.addEventListener("keydown", handleKeydown);
	const previousOverflow = document.body.style.overflow;
	if (presentation === "bottom-sheet") document.body.style.overflow = "hidden";
	if (typeof dialog.showModal === "function") dialog.showModal();
	else dialog.setAttribute("open", "");
	queueMicrotask(() => {
		const fallbackSelector =
			"[autofocus], button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";
		(
			dialog.querySelector<HTMLElement>(initialFocus ?? fallbackSelector) ??
			dialog.querySelector<HTMLElement>(fallbackSelector)
		)?.focus();
	});
	return () => {
		dialog.removeEventListener("cancel", handleCancel);
		dialog.removeEventListener("keydown", handleKeydown);
		if (presentation === "bottom-sheet") document.body.style.overflow = previousOverflow;
		if (typeof dialog.close === "function" && dialog.open) dialog.close();
		queueMicrotask(() =>
			(returnFocus ? document.querySelector<HTMLElement>(returnFocus) : previous)?.focus(),
		);
	};
};
</script>

{#if open}
	<dialog
		{@attach showModal}
		data-section={dataSection}
		class="modal-panel"
		data-presentation={presentation}
		id={panelId}
		aria-labelledby={titleId}
		onclick={(event) => {
			if (event.target === event.currentTarget) onClose();
		}}
		style={`--modal-width: ${width}; --modal-max-height: ${maxHeight}`}
	>
		<button type="button" class="modal-close" aria-label={closeLabel} onclick={onClose} autofocus>
			<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"></path></svg>
		</button>
		{@render children()}
	</dialog>
{/if}

<style>
	.modal-panel { position: fixed; inset: 0; width: var(--modal-width); max-width: none; max-height: var(--modal-max-height); margin: auto; display: flex; flex-direction: column; gap: var(--space-md); padding: var(--space-xl); border: 0; border-radius: var(--radius-lg); background: var(--chronicle-card-surface-strong); box-shadow: var(--chronicle-shadow); color: inherit; overflow: hidden; }
	.modal-panel::backdrop { background: color-mix(in srgb, var(--chronicle-bg) 45%, transparent 55%); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
	.modal-close { position: absolute; right: var(--space-md); top: var(--space-md); display: grid; place-items: center; width: 34px; height: 34px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--chronicle-text-muted); cursor: pointer; }
	.modal-close:hover { background: var(--chronicle-panel-muted); color: var(--chronicle-text); }
	.modal-close:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 2px; }
	.modal-close svg { width: 18px; height: 18px; stroke: currentColor; stroke-width: 1.7; fill: none; }

	.modal-panel[data-presentation="bottom-sheet"] { inset: auto 0 0; width: min(100%, 560px); height: min(82svh, 720px); max-height: calc(100svh - max(48px, env(safe-area-inset-top))); margin: 0 auto; gap: 0; padding: 20px 16px max(14px, env(safe-area-inset-bottom)); border: 1px solid var(--chronicle-border-strong); border-bottom: 0; border-radius: 22px 22px 0 0; background: var(--chronicle-card-surface); animation: bottom-sheet-in 220ms cubic-bezier(0.16, 1, 0.3, 1); }
	.modal-panel[data-presentation="bottom-sheet"]::backdrop { background: color-mix(in srgb, var(--chronicle-text) 38%, transparent 62%); backdrop-filter: none; -webkit-backdrop-filter: none; }
	.modal-panel[data-presentation="bottom-sheet"] .modal-close { top: 16px; right: 16px; width: 40px; height: 40px; border: 1px solid var(--chronicle-border); background: var(--chronicle-panel-muted); }

	@keyframes bottom-sheet-in { from { transform: translateY(18px); opacity: 0.88; } }

	@media (prefers-reduced-motion: reduce) {
		.modal-panel[data-presentation="bottom-sheet"] { animation: none; }
	}

	@media (max-width: 640px) {
		.modal-panel { padding: var(--space-lg); }
	}
</style>
