<script lang="ts">
import { isPlainShortcut, isTextEntryTarget } from "../lib/keyboard.js";
import { keyboardShortcutHelpOpen } from "../lib/keyboard-shortcuts-help.js";
import { dismissLatestToast, dismissToast, openToast, toastStore } from "../lib/toasts.svelte";

function toastKicker(eventType: string, level: "warn" | "error"): string {
	if (eventType === "action_required") {
		return "Action required";
	}
	return level === "error" ? "Error" : "Heads up";
}

$effect(() => {
	const shortcutHelpOpen = $keyboardShortcutHelpOpen;

	const handleWindowKeydown = (event: KeyboardEvent) => {
		if (
			event.defaultPrevented ||
			shortcutHelpOpen ||
			!isPlainShortcut(event) ||
			isTextEntryTarget(event.target) ||
			event.key !== "Escape"
		) {
			return;
		}
		if ($toastStore.length === 0) {
			return;
		}
		event.preventDefault();
		dismissLatestToast();
	};

	window.addEventListener("keydown", handleWindowKeydown);
	return () => {
		window.removeEventListener("keydown", handleWindowKeydown);
	};
});
</script>

{#if $toastStore.length > 0}
	<div class="toast-container" aria-live="polite" aria-atomic="false">
		{#each $toastStore as toast (toast.id)}
			<div class="toast" class:warn={toast.level === "warn"} class:error={toast.level === "error"}>
				<button
					type="button"
					class="toast-open"
					data-pressable="true"
					onclick={() => openToast(toast.id)}
				>
					<div class="toast-copy">
						<p class="toast-title">
							<span class="toast-kicker">{toastKicker(toast.eventType, toast.level)}</span>
							<span class="toast-shortcut">Esc dismisses the newest message</span>
						</p>
						<p class="toast-message">{toast.message}</p>
					</div>
				</button>
				<button
					type="button"
					class="toast-dismiss"
					data-pressable="true"
					onclick={() => dismissToast(toast.id)}
				>
					Dismiss
				</button>
			</div>
		{/each}
	</div>
{/if}

<style>
	.toast-container {
		position: fixed;
		top: 16px;
		right: 16px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		z-index: 1000;
		max-width: min(440px, calc(100vw - 32px));
	}

	.toast {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 14px;
		padding: 14px 16px;
		border-radius: 16px;
		border: 1px solid var(--chronicle-border);
		background: color-mix(in srgb, var(--chronicle-panel-surface) 92%, var(--chronicle-panel-muted) 8%);
		box-shadow: var(--chronicle-shadow-soft);
	}

	.toast.warn {
		border-color: color-mix(in srgb, var(--chronicle-attention) 42%, var(--chronicle-border) 58%);
		background: color-mix(in srgb, white 90%, var(--chronicle-attention) 10%);
	}

	.toast.error {
		border-color: color-mix(in srgb, var(--chronicle-danger) 38%, var(--chronicle-border) 62%);
		background: color-mix(in srgb, white 90%, var(--chronicle-danger) 10%);
	}

	.toast-open {
		flex: 1;
		min-width: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.toast-copy {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	.toast-title {
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: baseline;
	}

	.toast-kicker {
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--chronicle-text);
	}

	.toast-shortcut {
		font-size: 12px;
		line-height: 1.4;
		color: var(--chronicle-text-muted);
	}

	.toast-message {
		margin: 0;
		font-size: 14px;
		line-height: 1.55;
		color: var(--chronicle-text);
	}

	.toast-open:hover .toast-message,
	.toast-open:focus-visible .toast-message {
		text-decoration: underline;
	}

	.toast-dismiss {
		min-height: 44px;
		padding: 0 14px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border-strong) 84%, white 16%);
		border-radius: 999px;
		background: color-mix(in srgb, var(--chronicle-card-surface) 92%, white 8%);
		color: var(--chronicle-text);
		cursor: pointer;
		flex-shrink: 0;
	}

	.toast-dismiss:hover {
		transform: translateY(-1px);
		border-color: color-mix(in srgb, var(--chronicle-accent) 22%, var(--chronicle-border-strong) 78%);
	}

	@media (max-width: 720px) {
		.toast-container {
			left: 12px;
			right: 12px;
			top: 12px;
			max-width: none;
		}

		.toast {
			padding: 12px 14px;
		}

		.toast-title {
			gap: 6px;
		}

		.toast-shortcut {
			width: 100%;
		}
	}
</style>
