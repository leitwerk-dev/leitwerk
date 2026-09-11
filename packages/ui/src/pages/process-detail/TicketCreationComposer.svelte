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
let ticketToolLoadRequest = $state(0);
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
	void ticketToolLoadRequest;
	ticketTools = [];
	selectedTicketTool = "";
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
	dismissible={!ticketLaunching}
>
	<header class="ticket-composer-header">
		<h2 id="ticket-composer-title">Create issue</h2>
		<p>Start an issue draft from this result. You’ll review it before it is published.</p>
	</header>
	<div class="ticket-composer-body">
		{#if draft?.excerpt}
			<details class="ticket-source"><summary>Selected text</summary><blockquote>{draft.excerpt}</blockquote></details>
		{:else}
			<p class="ticket-source-note">The full result will be included as context.</p>
		{/if}
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
		{:else if ticketTools.length === 1}
			<p class="ticket-source-note">Ticket system: {ticketTools[0].displayName}</p>
		{:else if ticketTools.length === 0 && !ticketError}
			<p class="ticket-composer-state">No ticket system is available. Ask your administrator to configure one before creating an issue.</p>
		{/if}
		{#if ticketError}
			<div class="ticket-composer-error" role="alert">
				<p>{ticketError}</p>
				{#if ticketTools.length === 0}<button type="button" class="ui-button" onclick={() => ticketToolLoadRequest++}>Try again</button>{/if}
			</div>
		{/if}
	</div>
	<footer class="ticket-composer-actions">
		<button type="button" class="ui-button" data-pressable="true" disabled={ticketLaunching} onclick={close}>Cancel</button>
		<button
			type="button"
			class="ui-button" data-variant="primary"
			data-pressable="true"
			disabled={!ticketInstructions.trim() || !selectedTicketTool || ticketLaunching || ticketToolsLoading}
			onclick={submitTicketDraft}
		>{ticketLaunching ? "Starting draft…" : "Draft issue"}</button>
	</footer>
</ModalShell>

<style>
	.ticket-composer-header {
		display: grid;
		gap: 6px;
		padding-right: var(--space-2xl);
	}

	.ticket-composer-header h2,
	.ticket-composer-header p,
	.ticket-composer-state,
	.ticket-composer-error {
		margin: 0;
	}

	.ticket-composer-header h2 {
		font-size: var(--type-title-md);
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

	.ticket-source-note, .ticket-source { margin: 0; font-size: var(--type-body-sm); line-height: 1.5; color: var(--chronicle-text-muted); }
	.ticket-source summary { padding: var(--space-xs) 0; cursor: pointer; }
	.ticket-source blockquote { margin: var(--space-xs) 0 0; padding: var(--space-sm); border-radius: var(--radius-sm); background: var(--chronicle-panel-muted); max-height: 140px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
	.ticket-composer-error { display: grid; gap: var(--space-sm); }
	.ticket-composer-error p { margin: 0; }
	.ticket-composer-actions { flex-wrap: wrap; flex-shrink: 0; }
</style>
