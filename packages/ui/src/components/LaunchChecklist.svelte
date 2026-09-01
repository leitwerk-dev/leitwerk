<script lang="ts">
import type { LaunchRun } from "@leitwerk-dev/domain";
import { onDestroy, onMount } from "svelte";
import { fetchLaunchRun, fetchProcessLaunchRuns } from "../lib/api.js";
import { onLaunchUpdated } from "../lib/launch-updates.js";

interface Props {
	launchRunId?: string | null;
	instanceId?: string | null;
	onInstanceAvailable?: (instanceId: string) => void;
	onTryAgain?: () => void;
}

let { launchRunId = null, instanceId = null, onInstanceAvailable, onTryAgain }: Props = $props();

let run = $state<LaunchRun | null>(null);
let loadError = $state<string | null>(null);
let knownAbsent = $state(false);
let expanded = $state(true);
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let notifiedInstanceId: string | null = null;

const terminal = $derived(
	run?.status === "completed" || run?.status === "failed" || run?.status === "cancelled",
);
const elapsedSeconds = $derived.by(() => {
	if (!run) return null;
	const workerStart = run.steps.find((step) => step.id === "start_worker")?.startedAt;
	const workerReady = run.steps.find((step) => step.id === "prepare_workspace")?.completedAt;
	if (!workerStart || !workerReady) return null;
	return Math.max(0, Math.round((Date.parse(workerReady) - Date.parse(workerStart)) / 1000));
});
const workerLifecycleSucceeded = $derived(
	run?.steps
		.filter((step) =>
			["start_worker", "connect_worker", "prepare_workspace", "start_first_turn"].includes(step.id),
		)
		.every((step) => step.status === "completed") ?? false,
);
const summary = $derived(
	run?.status === "completed"
		? workerLifecycleSucceeded
			? elapsedSeconds === null
				? "Process started"
				: `Process started in ${elapsedSeconds}s`
			: "Process created"
		: run?.status === "failed"
			? "Process startup needs attention"
			: run?.status === "cancelled"
				? "Process startup was cancelled"
				: "Starting process",
);

async function load() {
	const requestGeneration = ++generation;
	try {
		const next = launchRunId
			? await fetchLaunchRun(launchRunId)
			: instanceId
				? ((await fetchProcessLaunchRuns(instanceId)).at(-1) ?? null)
				: null;
		if (requestGeneration !== generation) return;
		run = next;
		knownAbsent = instanceId !== null && next === null;
		loadError = null;
		if (next?.instanceId && next.instanceId !== notifiedInstanceId) {
			notifiedInstanceId = next.instanceId;
			onInstanceAvailable?.(next.instanceId);
		}
		if (next?.status === "completed" || next?.status === "failed" || next?.status === "cancelled") {
			expanded = false;
		}
	} catch (error) {
		if (requestGeneration !== generation) return;
		loadError = error instanceof Error ? error.message : "Couldn't load launch progress";
	}
	if (!terminal && !knownAbsent) timer = setTimeout(() => void load(), 750);
}

$effect(() => {
	launchRunId;
	instanceId;
	if (timer) clearTimeout(timer);
	run = null;
	knownAbsent = false;
	loadError = null;
	void load();
});

onMount(() =>
	onLaunchUpdated((frame) => {
		if (
			(frame.payload.launchRunId === launchRunId ||
				(instanceId !== null && frame.payload.instanceId === instanceId)) &&
			!knownAbsent
		) {
			if (timer) clearTimeout(timer);
			timer = null;
			void load();
		}
	}),
);

onDestroy(() => {
	generation += 1;
	if (timer) clearTimeout(timer);
});
</script>

{#if !knownAbsent}
<section class="launch-checklist" aria-label="Process startup" aria-live="polite" data-status={run?.status ?? "loading"}>
	{#if loadError && !run}
		<div class="checklist-message" role="status">
			<p>{loadError}</p>
			<button type="button" class="text-button" onclick={() => void load()}>Retry progress</button>
		</div>
	{:else if !run}
		<p class="checklist-message">Preparing launch checklist…</p>
	{:else}
		<button
			type="button"
			class="summary-button"
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
		>
			<span
				class="summary-mark"
				data-status={run.status === "completed" && !workerLifecycleSucceeded ? "created" : run.status}
				aria-hidden="true"
			></span>
			<span>{summary}</span>
			<svg viewBox="0 0 20 20" aria-hidden="true" class:rotated={expanded}>
				<path d="m5 7 5 5 5-5" />
			</svg>
		</button>

		{#if expanded}
			<ol class="steps">
				{#each run.steps as item (item.id)}
					<li data-status={item.status}>
						<span class="step-icon" aria-hidden="true">
							{#if item.status === "completed"}
								<svg viewBox="0 0 20 20"><path d="m4 10 4 4 8-9" /></svg>
							{:else if item.status === "failed"}
								<svg viewBox="0 0 20 20"><path d="M10 4v7m0 4v.01" /></svg>
							{:else if item.status === "skipped"}
								<svg viewBox="0 0 20 20"><path d="M5 10h10" /></svg>
							{:else}
								<span class="dot"></span>
							{/if}
						</span>
						<span class="step-copy">
							<span class="step-label">{item.label}</span>
							<span class="sr-only">
								{item.status === "in_progress" ? "In progress" : item.status[0]?.toUpperCase() + item.status.slice(1)}
							</span>
							{#if item.safeSummary}
								<span class="step-summary">{item.safeSummary}</span>
							{/if}
						</span>
					</li>
				{/each}
			</ol>
			{#if run.status === "failed" && onTryAgain}
				<button type="button" class="try-again" onclick={onTryAgain}>Try again</button>
			{/if}
		{/if}
	{/if}
</section>
{/if}

<style>
	.launch-checklist {
		width: min(100%, 680px);
		border-block: 1px solid var(--chronicle-border);
		background: var(--chronicle-panel-surface);
	}
	.summary-button {
		display: grid;
		grid-template-columns: 12px 1fr 20px;
		align-items: center;
		gap: var(--space-sm);
		width: 100%;
		padding: var(--space-md) 0;
		border: 0;
		background: transparent;
		color: var(--chronicle-text);
		font: inherit;
		font-weight: 650;
		text-align: left;
		cursor: pointer;
	}
	.summary-button:focus-visible,
	.text-button:focus-visible,
	.try-again:focus-visible {
		outline: 2px solid var(--chronicle-accent);
		outline-offset: 3px;
	}
	.summary-button svg {
		width: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.7;
		transition: transform var(--duration-fast) var(--ease-out-quart);
	}
	.summary-button svg.rotated { transform: rotate(180deg); }
	.summary-mark {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--chronicle-accent);
	}
	.summary-mark[data-status="completed"] { background: var(--chronicle-success); }
	.summary-mark[data-status="created"] { background: var(--chronicle-text-muted); }
	.summary-mark[data-status="failed"] { background: var(--chronicle-danger); }
	.steps {
		position: relative;
		display: grid;
		gap: 0;
		margin: 0;
		padding: 0 0 var(--space-md);
		list-style: none;
	}
	.steps::before {
		position: absolute;
		top: 13px;
		bottom: 13px;
		left: 9px;
		width: 1px;
		background: var(--chronicle-border);
		content: "";
	}
	li {
		position: relative;
		display: grid;
		grid-template-columns: 20px 1fr;
		gap: var(--space-sm);
		min-height: 36px;
		color: var(--chronicle-text-faint);
	}
	li[data-status="in_progress"] { color: var(--chronicle-accent); font-weight: 650; }
	li[data-status="completed"] { color: var(--chronicle-text); }
	li[data-status="failed"] { color: var(--chronicle-danger-text); }
	.step-icon {
		position: relative;
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		background: var(--chronicle-panel-surface);
	}
	.step-icon svg { width: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
	.dot { width: 8px; height: 8px; border: 1.5px solid currentColor; border-radius: 50%; background: var(--chronicle-panel-surface); }
	li[data-status="in_progress"] .dot { background: currentColor; box-shadow: 0 2px 8px color-mix(in srgb, var(--chronicle-accent) 32%, transparent); }
	.step-copy { display: grid; gap: 2px; padding-bottom: var(--space-sm); }
	.step-label { line-height: 20px; }
	.step-summary { max-width: 65ch; color: var(--chronicle-text-muted); font-size: var(--type-body-sm); font-weight: 400; line-height: 1.45; }
	.checklist-message { margin: 0; padding: var(--space-md) 0; color: var(--chronicle-text-muted); }
	.text-button { padding: 0; border: 0; background: transparent; color: var(--chronicle-link); font: inherit; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
	.try-again { margin: var(--space-xs) 0 var(--space-md) var(--space-xl); padding: 8px 14px; border: 1px solid var(--chronicle-border-strong); border-radius: var(--radius-sm); background: var(--chronicle-panel-surface); color: var(--chronicle-text); font: inherit; font-weight: 650; cursor: pointer; }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
	@media (prefers-reduced-motion: reduce) { .summary-button svg { transition: none; } }
</style>
