<script lang="ts">
import type { ProcessLifecycleStatus } from "@leitwerk-dev/domain";
import PageHeader from "../../components/PageHeader.svelte";
import ProcessActionsMenu from "../../components/ProcessActionsMenu.svelte";
import type { ProcessDetailData } from "../../lib/api.js";
import { formatDefinition, formatStatus } from "../../lib/format.js";

interface Props {
	instanceId: string;
	titleId: string;
	detail: ProcessDetailData | null;
	isProcessInfoOpen: boolean;
	onToggleProcessInfo: () => void;
	onDeleted: () => void;
}

let { instanceId, titleId, detail, isProcessInfoOpen, onToggleProcessInfo, onDeleted }: Props =
	$props();

const header = $derived.by(() => {
	if (!detail) {
		return { title: `Process ${instanceId}`, processDisplayName: null };
	}
	const title = detail.process.title ?? detail.process.externalId ?? detail.process.id;
	const processDisplayName =
		detail.processDisplayName?.trim() || formatDefinition(detail.process.processId);
	return { title, processDisplayName: title === processDisplayName ? null : processDisplayName };
});

const status = $derived.by(() => {
	const lifecycleStatus = detail?.process.lifecycleStatus ?? null;
	return lifecycleStatus
		? {
				status: lifecycleStatus,
				label: formatStatus(lifecycleStatus),
				mark: processStatusMark(lifecycleStatus),
			}
		: null;
});

function processStatusMark(status: ProcessLifecycleStatus): string {
	if (status === "completed") {
		return "✓";
	}
	if (status === "aborted") {
		return "✕";
	}
	return status === "error" || status === "waiting" ? "!" : "●";
}
</script>

<PageHeader title={header.title} {titleId}>
	{#snippet titleSuffix()}
		{#if header.processDisplayName}
			<span class="page-header-process-name"> · {header.processDisplayName}</span>
		{/if}
	{/snippet}

	{#snippet actions()}
		{#if status}
			<span
				class="process-header-status"
				data-process-status={status.status}
				data-section="process-header-status"
				aria-label={`Process state: ${status.label}`}
			>
				<span class="process-header-status-mark" aria-hidden="true">
					{#if status.mark === "●"}
						<span class="process-header-status-dot"></span>
					{:else}
						{status.mark}
					{/if}
				</span>
				{status.label}
			</span>
		{/if}
		<button
			type="button"
			class="page-header-button process-info-trigger"
			data-pressable="true"
			onclick={onToggleProcessInfo}
			aria-expanded={isProcessInfoOpen}
			aria-controls="process-info-overlay"
			disabled={!detail}
		>
			Process info
		</button>
		<ProcessActionsMenu
			{instanceId}
			lifecycleStatus={detail?.process.lifecycleStatus ?? null}
			disabled={!detail}
			hasSessionFile={detail?.session.signature !== null}
			processLabel={header.title}
			{onDeleted}
		/>
	{/snippet}
</PageHeader>

<style>

	.process-header-status {
		--process-header-status-tone: var(--chronicle-accent);
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 0 var(--space-xs);
		color: color-mix(in srgb, var(--process-header-status-tone) 76%, var(--chronicle-text) 24%);
		font-size: var(--type-body-sm);
		font-weight: 720;
		line-height: 1;
		white-space: nowrap;
	}

	.process-header-status[data-process-status="completed"] {
		--process-header-status-tone: var(--chronicle-success);
	}

	.process-header-status[data-process-status="aborted"] {
		--process-header-status-tone: #8a6044;
	}

	.process-header-status[data-process-status="error"] {
		--process-header-status-tone: var(--chronicle-danger);
	}

	.process-header-status[data-process-status="waiting"] {
		--process-header-status-tone: var(--chronicle-attention);
	}

	.process-header-status[data-process-status="discovered"] {
		--process-header-status-tone: var(--chronicle-text-faint);
	}

	.process-header-status-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--process-header-status-tone) 12%, white 88%);
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 900;
		line-height: 1;
	}

	.process-header-status-dot {
		width: 6px;
		height: 6px;
		border-radius: 999px;
		background: currentColor;
	}

	.page-header-process-name {
		color: var(--chronicle-text-muted);
		font-weight: 520;
	}

	@media (max-width: 720px) {
		.process-header-status,
		.process-info-trigger {
			width: 100%;
			justify-content: center;
		}
	}
</style>
