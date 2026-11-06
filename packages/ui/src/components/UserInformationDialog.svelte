<script lang="ts">
import type { UserInformationResponseBody } from "@leitwerk-dev/protocol/http-contracts";
import { fetchUserInformation } from "../lib/api.js";
import { formatLocalDateTime } from "../lib/format.js";
import ModalShell from "./ModalShell.svelte";

let { onClose }: { onClose: () => void } = $props();
let information = $state<UserInformationResponseBody | null>(null);
let error = $state<string | null>(null);
let loading = $state(true);
const claims = $derived({ ...information?.idTokenClaims, ...information?.userInfoClaims });
function text(value: unknown): string {
	return typeof value === "string" && value.trim() ? value : "Not provided";
}
async function load() {
	loading = true;
	error = null;
	try {
		information = await fetchUserInformation();
	} catch {
		error = "Could not load user information. Try again or log in again.";
	} finally {
		loading = false;
	}
}
$effect(() => {
	void load();
});
</script>

<ModalShell open={true} titleId="user-information-title" closeLabel="Close user information" {onClose} restoreFocusSelector="[data-action='user-menu']" dataSection="user-information">
	<h2 id="user-information-title">User information</h2>
	<div class="information-body" aria-busy={loading}>
		<p class="note">This information reflects your last login. Log in again to refresh it.</p>
		{#if loading}
			<p role="status">Loading user information…</p>
		{:else if error}
			<p role="alert">{error}</p>
			<button class="ui-button" type="button" onclick={load}>Try again</button>
		{:else if information}
			<dl>
				<dt>Name</dt><dd>{text(claims.name)}</dd>
				<dt>Username</dt><dd>{information.facts.identity}</dd>
				<dt>Email</dt><dd>{information.facts.email ?? "Not provided"} · {information.facts.emailVerified ? "Verified" : "Not verified"}</dd>
				<dt>Provider</dt><dd>{information.providerId}<br />{information.issuer}</dd>
				<dt>Subject</dt><dd>{information.subject}</dd>
				<dt>Groups</dt><dd>{information.facts.groups.length ? information.facts.groups.join(", ") : "Not provided"}</dd>
				<dt>Login time</dt><dd>{formatLocalDateTime(information.loginAt)}</dd>
			</dl>
			<details>
				<summary tabindex="0">Provider claims</summary>
				<h3>ID token claims</h3>
				<pre>{JSON.stringify(information.idTokenClaims, null, 2)}</pre>
				<h3>UserInfo claims</h3>
				{#if information.userInfoClaims}<pre>{JSON.stringify(information.userInfoClaims, null, 2)}</pre>{:else}<p>Not received at last login.</p>{/if}
			</details>
		{/if}
	</div>
</ModalShell>

<style>
	h2 { margin: 0; padding-right: 32px; font-size: 20px; }
	.information-body { overflow: auto; min-height: 0; overflow-wrap: anywhere; }
	.note { color: var(--chronicle-text-muted); margin: 0 0 var(--space-lg); }
	dl { display: grid; grid-template-columns: minmax(80px, 1fr) minmax(0, 3fr); gap: var(--space-sm) var(--space-md); margin: 0 0 var(--space-lg); }
	dt { color: var(--chronicle-text-muted); }
	dd { margin: 0; }
	summary { cursor: pointer; padding: var(--space-sm) 0; }
	summary:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 2px; }
	h3 { font-size: 14px; margin-top: var(--space-md); }
	pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: var(--space-md); background: var(--chronicle-panel-muted); border-radius: var(--radius-sm); font-size: 14px; }
	@media (max-width: 480px) { dl { grid-template-columns: 1fr; gap: 4px; } dd { margin-bottom: var(--space-sm); } }
</style>
