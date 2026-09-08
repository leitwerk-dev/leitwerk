<script lang="ts">
import type { ProcessToolApprovalRequest } from "@leitwerk-dev/domain";
import { resolveToolApproval } from "../../lib/api.js";
import ReadonlyJsonValue from "./ReadonlyJsonValue.svelte";

let { request }: { request: ProcessToolApprovalRequest } = $props();
let feedback = $state("");
let pending = $state(false);
let error = $state<string | null>(null);
async function resolve(action: "accept" | "feedback" | "decline") {
	pending = true;
	error = null;
	try {
		await resolveToolApproval({
			instanceId: request.instanceId,
			requestId: request.id,
			body: { action, ...(action === "feedback" ? { feedback } : {}) },
		});
		request = { ...request, status: action === "accept" ? "accepted" : action };
	} catch (reason) {
		error = reason instanceof Error ? reason.message : String(reason);
	} finally {
		pending = false;
	}
}
</script>
<section class="approval" aria-labelledby={`approval-${request.id}`}>
	<h3 id={`approval-${request.id}`}>Review ticket creation</h3>
	{#if request.destination}
		<div class="destination"><span>Destination</span><strong>{request.destination.displayName}</strong>{#if request.destination.group}<small>{request.destination.group}</small>{/if}{#if request.destination.description}<small>{request.destination.description}</small>{/if}</div>
	{/if}
	<p>The ticket system will receive these exact read-only arguments.</p>
	<dl><ReadonlyJsonValue value={request.arguments} /></dl>
	{#if request.status === "open"}
		<label>Requested changes<textarea bind:value={feedback} rows="3"></textarea></label>
		<div class="actions"><button disabled={pending} onclick={() => resolve("accept")}>Accept</button><button disabled={pending || !feedback.trim()} onclick={() => resolve("feedback")}>Request changes</button><button disabled={pending} onclick={() => resolve("decline")}>Decline</button></div>
	{:else}<p>Review resolved: {request.status}</p>{/if}
	{#if error}<p role="alert">{error}</p>{/if}
</section>
<style>.approval{padding:1rem;border:1px solid var(--chronicle-border);border-radius:var(--radius-sm)}.destination{display:grid;gap:.15rem;padding:.75rem;border-radius:var(--radius-sm);background:var(--chronicle-panel-muted)}.destination span,.destination small{color:var(--chronicle-muted-text);font-size:var(--type-body-sm)}.approval label{display:grid;gap:.25rem}.actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.75rem}</style>
