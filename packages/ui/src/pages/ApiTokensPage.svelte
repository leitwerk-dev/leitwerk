<script lang="ts">
import type { Actor } from "@leitwerk-dev/domain";
import type { ApiTokensResponseBody } from "@leitwerk-dev/protocol/http-contracts";
import { onMount, tick } from "svelte";
import { createApiToken, fetchApiTokens, revokeApiToken } from "../lib/api-tokens.js";

let { authEnabled, actor }: { authEnabled: boolean; actor: Actor } = $props();
let data = $state<ApiTokensResponseBody | null>(null);
let loading = $state(true);
let busy = $state(false);
let error = $state("");
let notice = $state("");
let name = $state("");
let expiration = $state("default");
let date = $state("");
let secret = $state("");
let copyStatus = $state("");
let confirmAll = $state(false);
let alive = true;
let saveHeading = $state<HTMLHeadingElement | null>(null);
let nameField = $state<HTMLInputElement | null>(null);
const displayDate = (value: string) => new Date(value).toLocaleString();
const duration = (ms: number) =>
	ms >= 86400000 ? `${ms / 86400000} days` : `${ms / 60000} minutes`;
async function load() {
	loading = true;
	error = "";
	try {
		const result = await fetchApiTokens();
		if (alive) data = result;
	} catch (e) {
		if (alive) error = e instanceof Error ? e.message : "Could not load tokens. Try again.";
	} finally {
		if (alive) loading = false;
	}
}
onMount(() => {
	void load();
	return () => {
		alive = false;
		secret = "";
	};
});
function dismiss(restoreFocus = true) {
	secret = "";
	copyStatus = "";
	if (restoreFocus)
		void tick().then(() => {
			if (alive) nameField?.focus();
		});
}
async function create(event: SubmitEvent) {
	event.preventDefault();
	if (!data || busy || secret) return;
	busy = true;
	error = "";
	notice = "";
	try {
		const expiresAt =
			expiration === "none"
				? null
				: expiration === "canary"
					? new Date(Date.now() + 1800000).toISOString()
					: expiration === "date"
						? new Date(date).toISOString()
						: undefined;
		const result = await createApiToken(data.csrfToken, {
			name,
			...(expiresAt !== undefined ? { expiresAt } : {}),
		});
		if (!alive) return;
		secret = result.secret;
		copyStatus = "";
		name = "";
		data = { ...data, tokens: [result.token, ...data.tokens] };
		await tick();
		if (alive) {
			saveHeading?.focus();
			saveHeading?.scrollIntoView?.({ block: "center" });
		}
	} catch (e) {
		if (alive) error = e instanceof Error ? e.message : "Could not create token. Try again.";
	} finally {
		if (alive) busy = false;
	}
}
async function copy() {
	try {
		await navigator.clipboard.writeText(secret);
		if (alive && secret) copyStatus = "Copied to clipboard.";
	} catch {
		if (alive && secret) copyStatus = "Copy failed. Select the token and copy it manually.";
	}
}
async function revoke(id?: string) {
	if (!data || busy) return;
	busy = true;
	error = "";
	notice = "";
	try {
		await revokeApiToken(data.csrfToken, id);
		if (!alive) return;
		confirmAll = false;
		notice = id ? "Token revoked." : "All tokens revoked.";
		const result = await fetchApiTokens();
		if (alive) data = result;
	} catch (e) {
		if (alive) error = e instanceof Error ? e.message : "Could not revoke tokens. Try again.";
	} finally {
		if (alive) busy = false;
	}
}
</script>

<svelte:window onpagehide={() => dismiss(false)} />
<div class="tokens-page">
 <header>
 <h1>API tokens</h1>
 <p class="identity">{authEnabled ? actor.displayName ?? actor.id : "Anonymous"}</p>
 <p>Tokens grant full application HTTP API access as their owner. Save them securely and revoke tokens you no longer use. Logging out does not revoke them.</p>
 {#if !authEnabled}<p class="shared-owner">Every visitor shares the anonymous token owner and can view and revoke every anonymous token.</p>{/if}
 </header>
 {#if error}<p role="alert" class="error">{error}</p>{/if}
 {#if notice}<p role="status">{notice}</p>{/if}
 {#if loading && !data}<p role="status">Loading tokens…</p>
 {:else if !data}<button type="button" onclick={load}>Try again</button>
 {:else}
 {#if secret}
 <section class="secret-display" aria-labelledby="save-token-heading">
 <h2 id="save-token-heading" bind:this={saveHeading} tabindex="-1" aria-describedby="save-token-instruction">Save your token now</h2>
 <p id="save-token-instruction">This secret appears only once. Save it before dismissing this message or leaving the page.</p>
 <label for="new-token">New API token</label>
 <textarea id="new-token" readonly value={secret} rows="2" spellcheck="false" autocomplete="off"></textarea>
 <div class="actions"><button type="button" onclick={copy}>Copy token</button><button type="button" onclick={() => dismiss()}>I saved it — dismiss</button></div>
 {#if copyStatus}<p role="status">{copyStatus}</p>{/if}
 </section>
 {/if}
 <section aria-labelledby="create-token-heading">
 <h2 id="create-token-heading">Create a token</h2>
 {#if !data.policy.enabled}<p>Token issuance is disabled. You can still view and revoke existing tokens.</p>
 {:else}
 <form onsubmit={create}>
 <label for="token-name">Name</label>
 <input id="token-name" bind:this={nameField} bind:value={name} required maxlength="100" placeholder="e.g. Release automation" autocomplete="off" disabled={busy || !!secret} />
 <label for="token-expiration">Expiration</label>
 <select id="token-expiration" bind:value={expiration} disabled={busy || !!secret}>
 <option value="default">Default ({duration(data.policy.defaultTtlMs)})</option>
 {#if data.policy.maxTtlMs >= 1800000}<option value="canary">30 minutes</option>{/if}
 <option value="date">Choose date and time</option>
 {#if data.policy.allowNoExpiry}<option value="none">No expiration</option>{/if}
 </select>
 {#if expiration === "date"}
 <label for="token-date">Expiration date and time (local time)</label>
 <input id="token-date" type="datetime-local" bind:value={date} required disabled={busy || !!secret} />
 {/if}
 <p class="hint">Dated tokens may last up to {duration(data.policy.maxTtlMs)}.</p>
 <button class="primary" type="submit" disabled={busy || !!secret || !name.trim()}>{busy ? "Working…" : "Create token"}</button>
 </form>
 {/if}
 </section>
 <section aria-labelledby="your-tokens-heading">
 <div class="section-heading"><h2 id="your-tokens-heading">{authEnabled ? "Your tokens" : "Shared anonymous tokens"}</h2><button type="button" disabled={busy || loading} onclick={load}>Refresh</button></div>
 {#if data.tokens.length === 0}<p>No tokens yet. Create one to connect an HTTP API client.</p>
 {:else}
 <ul class="token-list">
 {#each data.tokens as token (token.id)}
 <li>
 <div class="token-heading"><h3>{token.name}</h3><span>{token.revokedAt ? "Revoked" : token.expiresAt && Date.parse(token.expiresAt) <= Date.now() ? "Expired" : "Active"}</span></div>
 <p class="token-id"><code>{token.prefix}…</code> · {token.id}</p>
 <dl><div><dt>Created</dt><dd>{displayDate(token.createdAt)}</dd></div><div><dt>Expires</dt><dd>{token.expiresAt ? displayDate(token.expiresAt) : "No expiration"}</dd></div><div><dt>Last used</dt><dd>{token.lastUsedAt ? displayDate(token.lastUsedAt) : "Never"}</dd></div>{#if token.revokedAt}<div><dt>Revoked</dt><dd>{displayDate(token.revokedAt)}</dd></div>{/if}</dl>
 {#if !token.revokedAt}<button type="button" class="danger" disabled={busy} aria-label={`Revoke ${token.name}`} onclick={() => revoke(token.id)}>Revoke</button>{/if}
 </li>
 {/each}
 </ul>
 {#if data.tokens.some((token) => !token.revokedAt)}
 {#if confirmAll}
 <div class="revoke-confirmation"><p>Revoke all {authEnabled ? "your" : "shared anonymous"} tokens? Every client using them will lose access. Accepted work and schedules will continue.</p><div class="actions"><button type="button" class="danger" disabled={busy} onclick={() => revoke()}>Confirm revoke all</button><button type="button" disabled={busy} onclick={() => { confirmAll = false; }}>Cancel</button></div></div>
 {:else}<button type="button" class="danger" disabled={busy} onclick={() => { confirmAll = true; }}>Revoke all tokens</button>{/if}
 {/if}
 {/if}
 </section>
 {/if}
</div>
<style>
.tokens-page { max-width: 900px; width: 100%; margin: 0 auto; padding: var(--space-lg) 0 var(--space-2xl); }
h1 { font-size: var(--type-title-lg); margin: 0 0 var(--space-xs); }
h2 { font-size: var(--type-title-md); margin: 0 0 var(--space-md); }
h3 { font-size: var(--type-body-lg); margin: 0; overflow-wrap: anywhere; }
p { max-width: 72ch; color: var(--chronicle-text-muted); }
.identity { color: var(--chronicle-text); font-weight: 600; }
section { margin-top: var(--space-xl); padding-top: var(--space-lg); border-top: 1px solid var(--chronicle-border); }
form { display: grid; gap: var(--space-sm); max-width: 480px; }
label { display: block; font-weight: 600; }
input, select, textarea { width: 100%; min-width: 0; min-height: 44px; padding: 10px 12px; border: 1px solid var(--chronicle-border-strong); border-radius: var(--radius-sm); background: var(--chronicle-panel-surface); color: var(--chronicle-text); caret-color: var(--chronicle-accent); }
input::placeholder { color: var(--chronicle-text-muted); }
button { min-height: 44px; padding: 10px 16px; border: 1px solid var(--chronicle-border-strong); border-radius: var(--radius-sm); background: var(--chronicle-panel-surface); color: var(--chronicle-text); cursor: pointer; }
button:hover:not(:disabled) { background: var(--chronicle-panel-muted); }
button:disabled { opacity: .55; cursor: default; }
.primary { background: var(--chronicle-accent); color: var(--chronicle-text-on-accent); border-color: var(--chronicle-accent); justify-self: start; }
.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--chronicle-accent) 88%, black); }
.danger, .error { color: var(--chronicle-danger-text); }
.hint { font-size: var(--type-body-sm); margin: 0 0 var(--space-xs); }
.secret-display { background: var(--chronicle-panel-muted); padding: var(--space-lg); border: 0; border-radius: var(--radius-md); }
textarea { font-family: var(--font-mono); resize: vertical; margin: var(--space-xs) 0 var(--space-md); overflow-wrap: anywhere; }
.actions, .section-heading, .token-heading { display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap; }
.section-heading, .token-heading { justify-content: space-between; }
.section-heading h2 { margin: 0; }
.token-list { padding: 0; list-style: none; margin: var(--space-md) 0; }
li { padding: var(--space-lg) 0; border-bottom: 1px solid var(--chronicle-border); }
.token-id { overflow-wrap: anywhere; font-size: var(--type-body-sm); }
dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-md); font-size: var(--type-body-sm); font-variant-numeric: tabular-nums; }
dt { color: var(--chronicle-text-muted); } dd { margin: var(--space-2xs) 0 0; }
.revoke-confirmation { padding: var(--space-md); background: var(--chronicle-danger-surface-soft); }
@media (max-width: 600px) { .tokens-page { padding-top: var(--space-sm); } .secret-display { padding: var(--space-md); } }
</style>
