<script lang="ts">
import { type ProcessToolApprovalRequest, resolveJsonPointer } from "@leitwerk-dev/domain";
import type { TicketCreationToolSummary } from "@leitwerk-dev/protocol";
import { tick } from "svelte";
import { fetchTicketCreationTools, resolveToolApproval } from "../../lib/api.js";
import ChronicleMarkdown from "./ChronicleMarkdown.svelte";
import ReadonlyJsonValue from "./ReadonlyJsonValue.svelte";

let { request }: { request: ProcessToolApprovalRequest } = $props();
let feedback = $state("");
let feedbackOpen = $state(false);
let feedbackInput: HTMLTextAreaElement | undefined = $state();
let pending = $state<"accept" | "feedback" | "decline" | null>(null);
let error = $state<string | null>(null);
let tool = $state<TicketCreationToolSummary | undefined>();

function textAt(pointer: string | undefined): string | null {
	if (!pointer) return null;
	const value = resolveJsonPointer(request.arguments, pointer);
	return typeof value === "string" ? value : null;
}

const title = $derived(textAt(tool?.titlePath));
const description = $derived(textAt(tool?.descriptionPath));

$effect(() => {
	const name = request.toolName;
	let cancelled = false;
	void fetchTicketCreationTools()
		.then((tools) => {
			if (!cancelled) tool = tools.find((candidate) => candidate.name === name);
		})
		.catch(() => {});
	return () => {
		cancelled = true;
	};
});

async function resolve(action: "accept" | "feedback" | "decline") {
	if (pending || request.status !== "open" || (action === "feedback" && !feedback.trim())) return;
	pending = action;
	error = null;
	try {
		await resolveToolApproval({
			instanceId: request.instanceId,
			requestId: request.id,
			body: { action, ...(action === "feedback" ? { feedback: feedback.trim() } : {}) },
		});
		request = {
			...request,
			status: action === "accept" ? "accepted" : action === "decline" ? "declined" : "feedback",
		};
	} catch (reason) {
		error = reason instanceof Error ? reason.message : String(reason);
	} finally {
		pending = null;
	}
}

async function requestChanges() {
	feedbackOpen = true;
	await tick();
	feedbackInput?.focus();
}
</script>

<section class="approval" aria-labelledby={`approval-${request.id}`} aria-busy={pending !== null} data-section="ticket-approval">
	<header>
		<h3 id={`approval-${request.id}`}>Review issue</h3>
		<p>Check the draft and destination before creating the issue.</p>
	</header>
	{#if request.destination}
		<div class="destination">
			<span>{tool?.displayName ?? "Destination"}</span>
			<strong>{request.destination.displayName}</strong>
			{#if request.destination.group}<span>{request.destination.group}</span>{/if}
			{#if request.destination.description}<span>{request.destination.description}</span>{/if}
		</div>
	{/if}
	{#if title || description}
		<div class="draft-preview">
			{#if title}<h4>{title}</h4>{/if}
			{#if description}
				{#if tool?.descriptionFormat === "markdown"}<ChronicleMarkdown markdown={description} />
				{:else}<p class="draft-description">{description}</p>{/if}
			{/if}
		</div>
		<details class="ticket-fields"><summary>All issue fields</summary><dl><ReadonlyJsonValue value={request.arguments} /></dl></details>
	{:else}
		<div class="ticket-fields"><dl><ReadonlyJsonValue value={request.arguments} /></dl></div>
	{/if}
	{#if request.status === "open"}
		{#if feedbackOpen}
			<form class="feedback" onsubmit={(event) => { event.preventDefault(); void resolve("feedback"); }}>
				<label for={`ticket-feedback-${request.id}`}>What should change?</label>
				<textarea id={`ticket-feedback-${request.id}`} bind:this={feedbackInput} bind:value={feedback} rows="4" placeholder="Describe the changes you’d like in the next draft." disabled={pending !== null} required></textarea>
				<div class="actions">
					<button type="submit" class="ui-button" data-variant="primary" disabled={pending !== null || !feedback.trim()}>{pending === "feedback" ? "Sending changes…" : "Send changes"}</button>
					<button type="button" class="ui-button" disabled={pending !== null} onclick={() => (feedbackOpen = false)}>Back to review</button>
				</div>
			</form>
		{:else}
			<div class="actions">
				<button type="button" class="ui-button" data-variant="primary" disabled={pending !== null} onclick={() => resolve("accept")}>{pending === "accept" ? "Creating issue…" : "Create issue"}</button>
				<button type="button" class="ui-button" disabled={pending !== null} onclick={requestChanges}>Request changes</button>
				<button type="button" class="ui-button discard" disabled={pending !== null} onclick={() => resolve("decline")}>{pending === "decline" ? "Discarding…" : "Discard draft"}</button>
			</div>
		{/if}
	{:else}
		<p role="status">{request.status === "accepted" ? "Approved. The issue is being created." : request.status === "feedback" ? "Changes requested. A revised draft will appear here." : "Draft discarded. No issue was created."}</p>
	{/if}
	{#if error}<p class="approval-error" role="alert">{error}</p>{/if}
</section>

<style>
	.approval { display: grid; gap: var(--space-md); min-width: 0; padding: var(--space-lg); border: 1px solid var(--chronicle-border-strong); border-radius: var(--radius-md); background: var(--chronicle-card-surface); overflow-wrap: anywhere; }
	header { display: grid; gap: var(--space-xs); }
	h3, h4, p, dl { margin: 0; }
	h3 { font-size: var(--type-title-sm); }
	header p, .destination span { color: var(--chronicle-text-muted); font-size: var(--type-body-sm); }
	.destination { display: grid; gap: var(--space-2xs); padding: var(--space-sm) 0; border-block: 1px solid var(--chronicle-border); }
	.destination strong { font-weight: 650; }
	.draft-preview { display: grid; gap: var(--space-sm); min-width: 0; }
	h4 { font-size: var(--type-title-sm); line-height: 1.4; }
	.draft-description { white-space: pre-wrap; line-height: 1.6; max-width: 72ch; }
	.ticket-fields { min-width: 0; font-size: var(--type-body-sm); }
	summary { display: list-item; cursor: pointer; padding: var(--space-sm) 0; color: var(--chronicle-text-muted); min-height: 44px; }
	summary:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 2px; }
	.feedback { display: grid; gap: var(--space-xs); }
	.feedback label { font-weight: 600; }
	textarea { width: 100%; padding: var(--space-sm); border: 1px solid var(--chronicle-border-strong); border-radius: var(--radius-sm); background: var(--chronicle-card-surface); color: var(--chronicle-text); font: inherit; line-height: 1.5; resize: vertical; }
	textarea:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 2px; }
	textarea::placeholder { color: var(--chronicle-text-muted); }
	.actions { display: flex; flex-wrap: wrap; gap: var(--space-xs); padding-top: var(--space-xs); }
	.discard { margin-left: auto; }
	.approval-error { padding: var(--space-sm); border-radius: var(--radius-sm); background: var(--chronicle-danger-surface-soft); color: var(--chronicle-danger-text-strong); }
	@media (max-width: 540px) {
		.approval { padding: var(--space-md); }
		.actions .ui-button { flex: 1 1 auto; }
		.discard { margin-left: 0; }
		textarea { font-size: 16px; }
	}
</style>
