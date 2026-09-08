<script lang="ts">
import type { TicketCreationToolSummary } from "@leitwerk-dev/protocol";
import type { ChronicleTicketDraftArtifact } from "../../chronicle/lib/chronicle-ticket-artifact.js";
import FormFieldRenderer from "../../components/FormFieldRenderer.svelte";
import ModalShell from "../../components/ModalShell.svelte";
import type { FormFieldDefinition } from "../../lib/api.js";
import { fetchTicketCreationTools, launchTicketCreation } from "../../lib/api.js";
import { buildProcessPath, navigate } from "../../lib/router.svelte.js";

interface Props {
	instanceId: string;
	draft: ChronicleTicketDraftArtifact | null;
	onClose: () => void;
}

let { instanceId, draft, onClose }: Props = $props();
let ticketTools = $state<TicketCreationToolSummary[]>([]);
let ticketToolsLoading = $state(false);
let selectedTicketTool = $state("");
let ticketInstructions = $state("");
let ticketError = $state<string | null>(null);
let ticketLaunching = $state(false);

const ticketInstructionsField: FormFieldDefinition<"textarea"> = {
	id: "ticket-instructions",
	label: "What issue should be created?",
	kind: "textarea",
	placeholder: "Describe the problem, expected outcome, and any important constraints.",
};
const ticketToolField: FormFieldDefinition<"select"> = {
	id: "ticket-tool",
	label: "Ticket system",
	kind: "select",
};

$effect(() => {
	if (!draft) return;
	let cancelled = false;
	ticketError = null;
	ticketToolsLoading = true;
	void fetchTicketCreationTools()
		.then((tools) => {
			if (cancelled) return;
			ticketTools = tools;
			selectedTicketTool = tools.length === 1 ? (tools[0]?.name ?? "") : "";
		})
		.catch((reason) => {
			if (!cancelled) ticketError = reason instanceof Error ? reason.message : String(reason);
		})
		.finally(() => {
			if (!cancelled) ticketToolsLoading = false;
		});
	return () => {
		cancelled = true;
	};
});

function close() {
	ticketInstructions = "";
	ticketError = null;
	onClose();
}

async function submitTicketDraft() {
	if (!draft || !selectedTicketTool) return;
	ticketLaunching = true;
	ticketError = null;
	try {
		const result = await launchTicketCreation(instanceId, {
			artifact:
				draft.kind === "turn_result"
					? { kind: "turn_result", turnRecordId: draft.turnRecordId }
					: { kind: "leaf_outcome", leafEntryId: draft.leafEntryId },
			focus: draft.excerpt ? { kind: "excerpt", excerpt: draft.excerpt } : { kind: "whole_result" },
			additionalInstructions: ticketInstructions.trim(),
			toolName: selectedTicketTool,
		});
		close();
		navigate(buildProcessPath(result.childInstanceId));
	} catch (reason) {
		ticketError = reason instanceof Error ? reason.message : String(reason);
	} finally {
		ticketLaunching = false;
	}
}
</script>

<ModalShell
	open={draft !== null}
	titleId="ticket-composer-title"
	closeLabel="Close issue creator"
	onClose={close}
	dataSection="ticket-composer"
	panelId="ticket-composer"
	width="min(100% - 32px, 520px)"
	maxHeight="min(85dvh, 620px)"
	initialFocusSelector="textarea"
>
	<header class="ticket-composer-header">
		<h2 id="ticket-composer-title">Create issue</h2>
		<p>Describe the issue to start a focused ticket-creation process.</p>
	</header>
	<div class="ticket-composer-body">
		<FormFieldRenderer
			field={ticketInstructionsField}
			id="ticket-instructions"
			value={ticketInstructions}
			textareaRows={6}
			onValueChange={(_, value) => (ticketInstructions = String(value))}
		/>
		{#if ticketToolsLoading}
			<p class="ticket-composer-state" role="status">Loading ticket systems…</p>
		{:else if ticketTools.length > 1}
			<FormFieldRenderer
				field={ticketToolField}
				id="ticket-tool"
				value={selectedTicketTool}
				options={ticketTools.map((tool) => ({ value: tool.name, label: tool.displayName }))}
				onValueChange={(_, value) => (selectedTicketTool = String(value))}
			/>
		{:else if ticketTools.length === 0 && !ticketError}
			<p class="ticket-composer-state">No ticket system is configured.</p>
		{/if}
		{#if ticketError}<p class="ticket-composer-error" role="alert">{ticketError}</p>{/if}
	</div>
	<footer class="ticket-composer-actions">
		<button type="button" class="ticket-button-secondary" data-pressable="true" onclick={close}>Cancel</button>
		<button
			type="button"
			class="ticket-button-primary"
			data-pressable="true"
			disabled={!ticketInstructions.trim() || !selectedTicketTool || ticketLaunching || ticketToolsLoading}
			onclick={submitTicketDraft}
		>{ticketLaunching ? "Creating…" : "Create"}</button>
	</footer>
</ModalShell>

<style>
	.ticket-composer-header {
		display: grid;
		gap: 6px;
		padding-right: var(--space-xl);
	}

	.ticket-composer-header h2,
	.ticket-composer-header p,
	.ticket-composer-state,
	.ticket-composer-error {
		margin: 0;
	}

	.ticket-composer-header h2 {
		font-size: var(--type-title);
		line-height: 1.2;
	}

	.ticket-composer-header p {
		max-width: 44ch;
		color: var(--chronicle-text-muted);
		font-size: var(--type-body-sm);
		line-height: 1.5;
	}

	.ticket-composer-body {
		display: grid;
		gap: var(--space-md);
		min-width: 0;
		overflow-y: auto;
		padding: 2px;
		scrollbar-color: var(--chronicle-border-strong) transparent;
	}

	.ticket-composer-state,
	.ticket-composer-error {
		padding: var(--space-sm);
		border-radius: 10px;
		background: var(--chronicle-panel-muted);
		color: var(--chronicle-text-muted);
		font-size: var(--type-body-sm);
	}

	.ticket-composer-error {
		border: 1px solid var(--chronicle-danger-border);
		background: var(--chronicle-danger-surface-soft);
		color: var(--chronicle-danger-text-strong);
	}

	.ticket-composer-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-xs);
		padding-top: var(--space-xs);
		border-top: 1px solid var(--chronicle-border);
	}

	.ticket-button-secondary,
	.ticket-button-primary {
		min-height: 44px;
		padding: 0 var(--space-md);
		border-radius: 999px;
		font: inherit;
		font-size: var(--type-body-sm);
		font-weight: 700;
		cursor: pointer;
	}

	.ticket-button-secondary {
		border: 1px solid var(--chronicle-border-strong);
		background: var(--chronicle-card-surface);
		color: var(--chronicle-text);
	}

	.ticket-button-primary {
		border: 1px solid var(--chronicle-text);
		background: var(--chronicle-text);
		color: var(--chronicle-card-surface);
	}

	.ticket-button-secondary:hover:not(:disabled),
	.ticket-button-primary:hover:not(:disabled) {
		transform: translateY(-1px);
	}

	.ticket-button-secondary:hover:not(:disabled) {
		border-color: var(--chronicle-accent);
	}

	.ticket-button-primary:hover:not(:disabled) {
		background: color-mix(in srgb, var(--chronicle-text) 88%, var(--chronicle-accent) 12%);
	}

	.ticket-button-secondary:focus-visible,
	.ticket-button-primary:focus-visible {
		outline: 2px solid var(--chronicle-accent);
		outline-offset: 2px;
	}

	.ticket-button-primary:disabled {
		opacity: 0.46;
		cursor: not-allowed;
	}

	@media (max-width: 720px) {
		:global(dialog[data-section="ticket-composer"]) {
			inset: auto 0 0;
			width: 100%;
			max-height: calc(100dvh - max(20px, env(safe-area-inset-top)));
			margin: 0;
			padding: var(--space-lg) var(--space-md) max(var(--space-md), env(safe-area-inset-bottom));
			border-radius: 22px 22px 0 0;
		}

		.ticket-composer-body {
			overscroll-behavior: contain;
		}

		.ticket-composer-actions {
			position: sticky;
			bottom: 0;
			padding-top: var(--space-sm);
			background: var(--chronicle-card-surface-strong);
		}

		.ticket-composer-actions button {
			flex: 1 1 0;
		}
	}
</style>
