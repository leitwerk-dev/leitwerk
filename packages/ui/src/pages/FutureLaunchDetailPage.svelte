<script lang="ts">
import GenericLauncher from "../components/GenericLauncher.svelte";
import PageHeader from "../components/PageHeader.svelte";
import {
	ApiResponseError,
	deleteFutureExecution,
	type FutureLaunchSummary,
	fetchFutureExecution,
	fetchLaunchers,
	type UiLauncherSummary,
} from "../lib/api.js";
import { formatLocalDateTime24Hour, formatUtcDateTime24Hour } from "../lib/format.js";
import { buildFutureLaunchDetailSections } from "../lib/future-launch-detail.js";
import { loadProcessesList, upsertFutureExecution } from "../lib/processes.svelte";
import {
	buildFutureLaunchPath,
	buildHomePath,
	buildProcessesPath,
	buildProcessPath,
	navigate,
} from "../lib/router.svelte";

interface Props {
	futureExecutionId: string;
}

let { futureExecutionId }: Props = $props();

let launchers = $state<UiLauncherSummary[]>([]);
let launchersLoading = $state(false);
let launchersError = $state<string | null>(null);
let editMode = $state(false);
let cancelConfirmOpen = $state(false);
let cancelBusy = $state(false);
let cancelError = $state<string | null>(null);
let loadedFutureLaunch = $state<FutureLaunchSummary | null>(null);
let futureLaunchDetailLoading = $state(false);
let futureLaunchDetailError = $state<string | null>(null);
let futureLaunchNotFound = $state(false);
let observedFutureExecutionId = $state<string | null>(null);
let launchersLoadToken = 0;
let futureLaunchDetailLoadToken = 0;

const homePath = buildHomePath();
const processesPath = buildProcessesPath();
const futureLaunch = $derived(
	loadedFutureLaunch?.id === futureExecutionId ? loadedFutureLaunch : null,
);
const launcher = $derived(
	futureLaunch ? (launchers.find((item) => item.id === futureLaunch.launcherId) ?? null) : null,
);
const detailSections = $derived(
	futureLaunch ? buildFutureLaunchDetailSections(futureLaunch, launcher) : [],
);
const initialSchedule = $derived(
	futureLaunch
		? {
				mode: futureLaunch.scheduleKind === "cron" ? "cron" : "once",
				...(futureLaunch.scheduleKind === "once" ? { runAt: futureLaunch.nextRunAt } : {}),
				...(futureLaunch.scheduleKind === "cron" && futureLaunch.cronExpression
					? { cronExpression: futureLaunch.cronExpression }
					: {}),
			}
		: null,
);

$effect(() => {
	if (observedFutureExecutionId === futureExecutionId) {
		return;
	}
	observedFutureExecutionId = futureExecutionId;
	editMode = false;
	cancelConfirmOpen = false;
	cancelError = null;
	loadedFutureLaunch = null;
	futureLaunchDetailLoading = false;
	futureLaunchDetailError = null;
	futureLaunchNotFound = false;
	futureLaunchDetailLoadToken += 1;
});

$effect(() => {
	void loadLaunchers();
});

$effect(() => {
	futureExecutionId;
	void loadFutureLaunchDetail();
});

async function loadFutureLaunchDetail() {
	const requestedId = futureExecutionId;
	const token = ++futureLaunchDetailLoadToken;
	futureLaunchDetailLoading = true;
	futureLaunchDetailError = null;
	futureLaunchNotFound = false;
	try {
		const result = await fetchFutureExecution(requestedId);
		if (token !== futureLaunchDetailLoadToken || futureExecutionId !== requestedId) {
			return;
		}
		if (result.kind !== "launch" || result.id !== requestedId) {
			futureLaunchDetailError = "The scheduled launch response did not match this page.";
			return;
		}
		loadedFutureLaunch = result;
	} catch (error) {
		if (token !== futureLaunchDetailLoadToken || futureExecutionId !== requestedId) {
			return;
		}
		if (error instanceof ApiResponseError && error.status === 404) {
			futureLaunchNotFound = true;
			return;
		}
		futureLaunchDetailError =
			error instanceof Error ? error.message : "Couldn't load scheduled launch details";
	} finally {
		if (token === futureLaunchDetailLoadToken) {
			futureLaunchDetailLoading = false;
		}
	}
}

function retryFutureLaunchDetail() {
	void loadFutureLaunchDetail();
}

async function loadLaunchers() {
	const token = ++launchersLoadToken;
	launchersLoading = true;
	launchersError = null;
	try {
		const result = await fetchLaunchers();
		if (token !== launchersLoadToken) {
			return;
		}
		launchers = result;
	} catch (error) {
		if (token !== launchersLoadToken) {
			return;
		}
		launchersError = error instanceof Error ? error.message : "Couldn't load process type details";
	} finally {
		if (token === launchersLoadToken) {
			launchersLoading = false;
		}
	}
}

function handleScheduled(updated: FutureLaunchSummary) {
	upsertFutureExecution(updated);
	loadedFutureLaunch = updated;
	editMode = false;
	cancelConfirmOpen = false;
	void loadProcessesList();
	navigate(buildFutureLaunchPath(updated.id), { replace: true });
}

function handleLaunched(instanceId: string) {
	void loadProcessesList();
	navigate(buildProcessPath(instanceId));
}

async function confirmCancel() {
	if (!futureLaunch) {
		return;
	}
	cancelBusy = true;
	cancelError = null;
	try {
		await deleteFutureExecution(futureLaunch.id);
		await loadProcessesList();
		navigate(homePath);
	} catch (error) {
		cancelError = error instanceof Error ? error.message : "Couldn't cancel this scheduled launch";
	} finally {
		cancelBusy = false;
	}
}
</script>

<div class="future-launch-page" data-page="future-launch-detail">
	{#if futureLaunch && editMode && launcher && initialSchedule}
		<section class="future-launch-editor" data-section="future-launch-edit">
			<PageHeader
				title={futureLaunch.title}
				subtitle="Update the saved launch details, then save to return to the schedule summary."
			/>
			<GenericLauncher
				{launcher}
				initialTitle={futureLaunch.launchTitle}
				initialValues={futureLaunch.launcherInput}
				initialSkillIds={futureLaunch.skillIds}
				initialModelConfig={futureLaunch.modelConfig}
				initialSchedule={initialSchedule}
				editingFutureLaunch={futureLaunch}
				onLaunched={handleLaunched}
				onScheduled={handleScheduled}
			/>
		</section>
	{:else if futureLaunch}
		<section class="future-launch-detail" data-section="future-launch-detail">
			<PageHeader
				title={futureLaunch.title}
				subtitle={`Launches ${formatLocalDateTime24Hour(futureLaunch.nextRunAt)} · ${formatUtcDateTime24Hour(futureLaunch.nextRunAt)}`}
			>
				{#snippet actions()}
					<button
						type="button"
						class="secondary-button"
						data-pressable="true"
						disabled={!launcher}
						title={launcher ? undefined : "Editing requires this process type to be available"}
						onclick={() => (editMode = true)}
					>
						Edit
					</button>
					<button
						type="button"
						class="danger-button"
						data-pressable="true"
						disabled={cancelBusy}
						onclick={() => (cancelConfirmOpen = true)}
					>
						Cancel scheduled launch
					</button>
				{/snippet}
			</PageHeader>

			{#if futureLaunch.status === "blocked" && futureLaunch.blockedReason}
				<div class="detail-warning" role="alert" data-section="model-policy-block">
					<strong>Blocked</strong> — {futureLaunch.blockedReason.summary}
					<p>Edit the model selection or restore model availability.</p>
				</div>
			{/if}

			{#if launchersError}
				<p class="detail-warning" role="status">Showing stored values. {launchersError}</p>
			{:else if launchersLoading && !launcher}
				<p class="detail-warning" role="status">Loading field labels…</p>
			{/if}

			{#if cancelConfirmOpen}
				<div class="cancel-confirm" data-section="cancel-confirmation" role="alertdialog" aria-modal="false" aria-labelledby="cancel-title">
					<div>
						<h2 id="cancel-title">Cancel this scheduled launch?</h2>
						<p>This launch will be removed and will not run at the scheduled time.</p>
						{#if cancelError}
							<p class="cancel-error" role="alert">{cancelError}</p>
						{/if}
					</div>
					<div class="confirm-actions">
						<button type="button" class="secondary-button" data-pressable="true" disabled={cancelBusy} onclick={() => (cancelConfirmOpen = false)}>
							Keep scheduled
						</button>
						<button type="button" class="danger-button" data-pressable="true" disabled={cancelBusy} onclick={() => void confirmCancel()}>
							{cancelBusy ? "Canceling…" : "Cancel launch"}
						</button>
					</div>
				</div>
			{/if}

			<div class="detail-sections">
				{#each detailSections as section (section.id)}
					<section class="detail-section" data-detail-section={section.id}>
						<h2>{section.title}</h2>
						<div class="detail-list">
							{#each section.items as item (`${section.id}:${item.label}`)}
								<div class="detail-item">
									<dt>{item.label}</dt>
									<dd>{section.id === "schedule" && item.label === "Launches" ? formatLocalDateTime24Hour(item.value) : item.value}</dd>
								</div>
							{/each}
						</div>
					</section>
				{/each}
			</div>
		</section>
	{:else if futureLaunchNotFound}
		<section class="future-launch-detail" data-section="future-launch-not-found">
			<PageHeader
				title="Scheduled launch no longer available"
				subtitle="It may have already run or been canceled."
			/>
			<div class="missing-state" role="status">
				<p>Check All processes for any process this schedule may have started.</p>
				<button type="button" class="secondary-button" onclick={() => navigate(processesPath)}>
					View all processes
				</button>
			</div>
		</section>
	{:else}
		<section class="future-launch-detail loading" data-section="future-launch-missing">
			<PageHeader title={futureLaunchDetailError ? "Couldn't load scheduled launch" : "Loading scheduled launch…"} />
			{#if futureLaunchDetailError}
				<div class="detail-load-error" role="status">
					<p class="detail-warning">{futureLaunchDetailError}</p>
					<button type="button" class="secondary-button" onclick={retryFutureLaunchDetail}>
						Retry
					</button>
				</div>
			{/if}
		</section>
	{/if}
</div>

<style>
	.future-launch-page {
		width: 100%;
		height: 100%;
		min-height: 0;
		overflow-y: auto;
		padding: var(--space-2xs) 0 var(--space-xl);
	}

	.future-launch-detail,
	.future-launch-editor {
		display: grid;
		gap: var(--space-lg);
		max-width: 980px;
	}

	.detail-warning,
	.cancel-confirm p {
		margin: 0;
		font-size: var(--type-body);
		line-height: 1.6;
		color: var(--chronicle-text-muted);
	}

	.detail-load-error,
	.missing-state {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
		flex-wrap: wrap;
	}

	.missing-state p {
		margin: 0;
		max-width: 70ch;
		font-size: var(--type-body);
		line-height: 1.6;
		color: var(--chronicle-text-muted);
	}

	.confirm-actions {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.secondary-button,
	.danger-button {
		min-height: 40px;
		padding: 0 var(--space-md);
		border-radius: 999px;
		font-weight: 650;
		cursor: pointer;
	}

	.secondary-button {
		border: 1px solid var(--chronicle-border-strong);
		background: color-mix(in srgb, var(--chronicle-card-surface) 94%, white 6%);
		color: var(--chronicle-text);
	}

	.danger-button {
		border: 1px solid var(--chronicle-danger-border);
		background: var(--chronicle-danger-surface-soft);
		color: var(--chronicle-danger-text-strong);
	}

	.secondary-button:disabled,
	.danger-button:disabled {
		opacity: 0.62;
		cursor: wait;
	}

	.detail-warning {
		padding: var(--space-sm) var(--space-md);
		border: 1px solid var(--chronicle-border);
		border-radius: var(--radius-md);
		background: var(--chronicle-panel-muted);
	}

	.cancel-confirm {
		display: flex;
		justify-content: space-between;
		gap: var(--space-lg);
		align-items: center;
		padding: var(--space-md);
		border: 1px solid var(--chronicle-danger-border);
		border-radius: var(--radius-lg);
		background: var(--chronicle-danger-surface);
	}

	.cancel-confirm h2 {
		margin: 0 0 var(--space-2xs);
		font-size: var(--type-body-lg);
		line-height: 1.3;
		color: var(--chronicle-danger-text-strong);
	}

	.cancel-error {
		margin-top: var(--space-xs) !important;
		color: var(--chronicle-danger-text-strong) !important;
	}

	.detail-sections {
		display: grid;
		gap: var(--space-md);
	}

	.detail-section {
		display: grid;
		gap: var(--space-sm);
		padding: var(--space-lg);
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 86%, white 14%);
		border-radius: var(--radius-lg);
		background: var(--chronicle-panel-surface);
		box-shadow: var(--chronicle-shadow-soft);
	}

	.detail-section h2 {
		margin: 0;
		font-size: var(--type-title-sm);
		line-height: 1.25;
		color: var(--chronicle-text);
	}

	.detail-list {
		display: grid;
		gap: var(--space-xs);
	}

	.detail-item {
		display: grid;
		grid-template-columns: minmax(140px, 220px) minmax(0, 1fr);
		gap: var(--space-md);
		padding-top: var(--space-xs);
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 70%, transparent 30%);
	}

	.detail-item dt,
	.detail-item dd {
		margin: 0;
		font-size: var(--type-body);
		line-height: 1.55;
	}

	.detail-item dt {
		font-weight: 650;
		color: var(--chronicle-text-muted);
	}

	.detail-item dd {
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--chronicle-text);
	}

	@media (max-width: 760px) {
		.cancel-confirm {
			display: grid;
		}

		.confirm-actions {
			justify-content: flex-start;
		}

		.detail-item {
			grid-template-columns: 1fr;
			gap: var(--space-2xs);
		}
	}
</style>
