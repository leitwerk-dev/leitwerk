<script lang="ts">
import PageHeader from "../components/PageHeader.svelte";
import type { UiLauncherSummary } from "../lib/api.js";
import ProcessCard from "./ProcessCard.svelte";

interface Props {
	launchers: UiLauncherSummary[];
	loading?: boolean;
	error?: string | null;
	unavailableLauncherId?: string | null;
	onRetry: () => void;
	onSelect: (launcherId: string) => void;
}

let {
	launchers,
	loading = false,
	error = null,
	unavailableLauncherId = null,
	onRetry,
	onSelect,
}: Props = $props();

let activeLauncherId = $state<string | null>(null);

$effect(() => {
	if (launchers.length === 0) {
		activeLauncherId = null;
		return;
	}
	if (!activeLauncherId || !launchers.some((launcher) => launcher.id === activeLauncherId)) {
		activeLauncherId = launchers[0]?.id ?? null;
	}
});

function focusCard(launcherId: string) {
	queueMicrotask(() => {
		const card = Array.from(document.querySelectorAll<HTMLElement>("[data-process-card-id]")).find(
			(candidate) => candidate.dataset.processCardId === launcherId,
		);
		card?.focus();
	});
}

/**
 * Number of columns the responsive grid is currently showing. Read from the
 * rendered `grid-template-columns` track list so vertical arrow movement steps
 * by a full row regardless of how many columns the viewport fits.
 */
function getColumnCount(): number {
	const grid = document.querySelector<HTMLElement>('[data-section="launcher-list"]');
	if (!grid) {
		return 1;
	}
	const tracks = getComputedStyle(grid)
		.gridTemplateColumns.split(" ")
		.filter((track) => track.trim().length > 0);
	return Math.max(1, tracks.length);
}

function focusIndex(index: number) {
	if (launchers.length === 0) {
		return;
	}
	const clamped = Math.max(0, Math.min(launchers.length - 1, index));
	const nextLauncherId = launchers[clamped]?.id;
	if (!nextLauncherId) {
		return;
	}
	activeLauncherId = nextLauncherId;
	focusCard(nextLauncherId);
}

function currentIndex(): number {
	const index = launchers.findIndex((launcher) => launcher.id === activeLauncherId);
	return index >= 0 ? index : 0;
}

function handleGalleryKeydown(event: KeyboardEvent) {
	if (event.defaultPrevented || launchers.length === 0) {
		return;
	}
	switch (event.key) {
		case "ArrowRight":
			event.preventDefault();
			focusIndex(currentIndex() + 1);
			return;
		case "ArrowLeft":
			event.preventDefault();
			focusIndex(currentIndex() - 1);
			return;
		case "ArrowDown":
			event.preventDefault();
			focusIndex(currentIndex() + getColumnCount());
			return;
		case "ArrowUp":
			event.preventDefault();
			focusIndex(currentIndex() - getColumnCount());
			return;
		case "Home":
			event.preventDefault();
			focusIndex(0);
			return;
		case "End":
			event.preventDefault();
			focusIndex(launchers.length - 1);
	}
}
</script>

<section class="process-gallery" data-section="process-gallery" aria-labelledby="process-gallery-title">
	<PageHeader
		title="Start a process"
		titleId="process-gallery-title"
		subtitle="Choose the workflow that matches the work. Each card shows the turns the process will guide you through before you open setup."
	/>

	{#if unavailableLauncherId}
		<div class="notice" role="status" data-state="launcher-unavailable">
			That process isn't available. Choose another process type to continue.
		</div>
	{/if}

	{#if loading && launchers.length === 0}
		<div class="gallery-state">Loading the process types you can launch…</div>
	{:else if error && launchers.length === 0}
		<div class="gallery-state gallery-error">
			<div>
				<p class="state-title">We couldn't load the available process types.</p>
				<p>{error}</p>
			</div>
			<button type="button" class="secondary-button" data-pressable="true" onclick={onRetry}>
				Retry
			</button>
		</div>
	{:else if launchers.length === 0}
		<div class="gallery-state">
			<p class="state-title">No process types are available yet.</p>
			<p>Check your configured extensions or start the server components that expose launchers.</p>
		</div>
	{:else}
		{#if error}
			<p class="gallery-refresh-error" role="status">
				We couldn't refresh the launcher list — showing the last process list we loaded.
			</p>
		{/if}
		<ul class="card-grid" data-section="launcher-list">
			{#each launchers as launcher (launcher.id)}
				<li>
					<ProcessCard
						{launcher}
						tabindexValue={launcher.id === activeLauncherId ? 0 : -1}
						onKeydown={handleGalleryKeydown}
						onSelect={(launcherId) => {
							activeLauncherId = launcherId;
							onSelect(launcherId);
						}}
					/>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.process-gallery {
		display: flex;
		flex-direction: column;
		gap: clamp(var(--space-lg), 2.8vw, var(--space-2xl));
		min-height: 0;
		padding: var(--space-2xs) 2px var(--space-xl);
	}

	.gallery-state p {
		margin: 0;
		font-size: 1rem;
		line-height: 1.62;
		color: var(--chronicle-text-muted);
	}

	.card-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
		gap: clamp(var(--space-md), 2vw, var(--space-xl));
		padding: 0;
		margin: 0;
		list-style: none;
	}

	.card-grid li {
		min-width: 0;
	}

	.notice,
	.gallery-state,
	.gallery-refresh-error {
		padding: 16px 18px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 86%, white 14%);
		border-radius: 18px;
		background: var(--chronicle-panel-muted);
	}

	.notice {
		border-color: color-mix(in srgb, var(--chronicle-accent) 28%, var(--chronicle-border) 72%);
		background: color-mix(in srgb, var(--chronicle-accent) 8%, var(--chronicle-panel-muted) 92%);
		color: var(--chronicle-text);
	}

	.gallery-error,
	.gallery-refresh-error {
		background: color-mix(in srgb, white 92%, var(--chronicle-danger) 8%);
		border-color: color-mix(in srgb, var(--chronicle-danger) 32%, var(--chronicle-border) 68%);
	}

	.gallery-error {
		display: grid;
		gap: 12px;
	}

	.gallery-refresh-error {
		margin: 0;
		font-size: 0.875rem;
		line-height: 1.55;
		color: var(--chronicle-danger-text);
	}

	.state-title {
		margin: 0 0 4px;
		font-size: 0.95rem;
		line-height: 1.35;
		font-weight: 620;
		color: var(--chronicle-text);
	}

	.secondary-button {
		align-self: flex-start;
		min-height: 44px;
		padding: 0 16px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border-strong) 84%, white 16%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 94%, white 6%);
		color: var(--chronicle-text);
		cursor: pointer;
	}

	.secondary-button:hover {
		transform: translateY(-1px);
		border-color: color-mix(in srgb, var(--chronicle-accent) 24%, var(--chronicle-border-strong) 76%);
	}
</style>
