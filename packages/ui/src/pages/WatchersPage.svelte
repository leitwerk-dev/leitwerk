<script lang="ts">
import PageHeader from "../components/PageHeader.svelte";
import { fetchWatchers, type WatcherSummary } from "../lib/api.js";

let watchers = $state<WatcherSummary[]>([]);
let loading = $state(false);
let error = $state<string | null>(null);
let loadToken = 0;

function formatLaunchModel(watcher: WatcherSummary): string {
	const parts: string[] = [];
	if (watcher.launchModel.defaultModelProfileId) {
		parts.push(`Default: ${watcher.launchModel.defaultModelProfileId}`);
	}
	if (watcher.launchModel.turnConfigs.length > 0) {
		parts.push(
			`Turns: ${watcher.launchModel.turnConfigs
				.map((turn) => `${turn.turnId} → ${turn.modelProfileId ?? "—"}`)
				.join(", ")}`,
		);
	}
	return parts.length > 0 ? parts.join(" · ") : "No watcher-specific launch model overrides";
}

async function loadWatchers() {
	const token = ++loadToken;
	loading = true;
	error = null;
	try {
		const result = await fetchWatchers();
		if (token !== loadToken) {
			return;
		}
		watchers = result;
	} catch (loadError) {
		if (token !== loadToken) {
			return;
		}
		error = loadError instanceof Error ? loadError.message : "Couldn't load registered watchers";
	} finally {
		if (token === loadToken) {
			loading = false;
		}
	}
}

$effect(() => {
	void loadWatchers();
});
</script>

<div class="watchers-page" data-page="watchers">
	<section class="watchers-shell">
		<PageHeader
			title="Watchers"
			subtitle="Review configured watcher registrations, their triggers, and launch model overrides."
		>
			{#snippet actions()}
				<button type="button" class="page-header-button" data-pressable="true" onclick={() => void loadWatchers()}>
					Refresh
				</button>
			{/snippet}
		</PageHeader>

		{#if loading && watchers.length === 0}
			<div class="state-card">Loading watcher registrations…</div>
		{:else if error && watchers.length === 0}
			<div class="state-card error" role="alert">
				<p class="state-title">We couldn't load the watcher registry.</p>
				<p>{error}</p>
			</div>
		{:else if watchers.length === 0}
			<div class="state-card">
				<p class="state-title">No watchers are currently registered.</p>
				<p>Configure process watchers in <code>leitwerk.yaml</code> to see them here.</p>
			</div>
		{:else}
			{#if error}
				<p class="refresh-error" role="status">
					We couldn't refresh the watcher list — showing the last data we loaded.
				</p>
			{/if}
			<div class="watcher-list">
				{#each watchers as watcher (`${watcher.processId}:${watcher.watcherId}`)}
					<article class="watcher-card" data-watcher-source={watcher.sourceId}>
						<header class="watcher-card-header">
							<div>
								<p class="watcher-type">{watcher.sourceLabel}</p>
								<h2>{watcher.label}</h2>
								<p class="watcher-description">{watcher.description}</p>
							</div>
							<span class:enabled={watcher.enabled} class="watcher-status">
								{watcher.enabled ? "Enabled" : "Disabled"}
							</span>
						</header>

						<dl class="watcher-meta">
							<div>
								<dt>Process</dt>
								<dd>{watcher.processDisplayName} <span class="muted">({watcher.processId})</span></dd>
							</div>
							<div>
								<dt>Watcher ID</dt>
								<dd>{watcher.watcherId}</dd>
							</div>
							<div>
								<dt>Target</dt>
								<dd>{watcher.targetSummary}</dd>
							</div>
							<div>
								<dt>Config path</dt>
								<dd><code>{watcher.configPath}</code></dd>
							</div>
							<div class="full-width">
								<dt>Launch model</dt>
								<dd>{formatLaunchModel(watcher)}</dd>
							</div>

							{#each watcher.details as detail}
								<div>
									<dt>{detail.label}</dt>
									<dd>
										{#if detail.format === "code"}<code>{detail.value}</code>{:else}{detail.value}{/if}
									</dd>
								</div>
							{/each}
						</dl>
					</article>
				{/each}
			</div>
		{/if}
	</section>
</div>

<style>
	.watchers-page {
		display: flex;
		min-height: 0;
	}

	.watchers-shell {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: var(--space-2xs) 2px var(--space-xl);
	}

	.state-card,
	.watcher-card {
		padding: 16px 18px;
		border-radius: 18px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 86%, white 14%);
		background: var(--chronicle-panel-muted);
	}

	.state-card.error {
		background: color-mix(in srgb, white 92%, var(--chronicle-danger) 8%);
		border-color: color-mix(in srgb, var(--chronicle-danger) 32%, var(--chronicle-border) 68%);
	}

	.state-title {
		margin: 0 0 4px;
		font-size: 0.95rem;
		line-height: 1.35;
		font-weight: 620;
		color: var(--chronicle-text);
	}

	.state-card p,
		.watcher-description,
		.refresh-error {
		color: var(--chronicle-text-muted);
	}

	.refresh-error {
		margin: 0;
		padding: 12px 14px;
		border-radius: 14px;
		background: color-mix(in srgb, white 92%, var(--chronicle-danger) 8%);
		border: 1px solid color-mix(in srgb, var(--chronicle-danger) 32%, var(--chronicle-border) 68%);
		font-size: 0.875rem;
		line-height: 1.55;
		color: var(--chronicle-danger-text);
	}

	.watcher-list {
		display: grid;
		gap: 14px;
	}

	.watcher-card {
		background: color-mix(in srgb, var(--chronicle-card-surface) 92%, var(--chronicle-panel-muted) 8%);
		border-color: color-mix(in srgb, var(--chronicle-border) 82%, white 18%);
	}

	.watcher-card-header {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		align-items: flex-start;
		margin-bottom: 14px;
	}

	.watcher-type {
		margin: 0 0 6px;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--chronicle-text-faint);
	}

	.watcher-card h2 {
		margin: 0;
		font-size: 1.12rem;
		line-height: 1.25;
		color: var(--chronicle-text);
	}

	.watcher-description {
		margin: 8px 0 0;
		font-size: 0.9rem;
		line-height: 1.55;
	}

	.watcher-status {
		padding: 6px 10px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border-strong) 82%, white 18%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 94%, white 6%);
		color: var(--chronicle-text-muted);
		font-size: 0.8rem;
		font-weight: 700;
	}

	.watcher-status.enabled {
		border-color: color-mix(in srgb, var(--chronicle-success) 32%, var(--chronicle-border) 68%);
		background: color-mix(in srgb, white 90%, var(--chronicle-success) 10%);
		color: color-mix(in srgb, var(--chronicle-success) 70%, var(--chronicle-text) 30%);
	}

	.watcher-meta {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px 18px;
		margin: 0;
	}

	.watcher-meta div {
		min-width: 0;
	}

	.watcher-meta dt {
		margin: 0 0 4px;
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--chronicle-text-faint);
	}

	.watcher-meta dd {
		margin: 0;
		color: var(--chronicle-text);
		word-break: break-word;
	}

	.full-width {
		grid-column: 1 / -1;
	}

	.muted {
		color: var(--chronicle-text-muted);
	}

	code {
		font-family: var(--font-mono, "SFMono-Regular", monospace);
		font-size: 0.92em;
		padding: 0.08em 0.35em;
		border-radius: 999px;
		background: color-mix(in srgb, var(--chronicle-card-surface) 92%, var(--chronicle-panel-muted) 8%);
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 78%, white 22%);
	}

	@media (max-width: 860px) {
		.watcher-meta {
			grid-template-columns: 1fr;
		}
	}
</style>
