<script lang="ts">
import type { ModelProfileOptionSummary, StartupRecoverySummary } from "@leitwerk-dev/protocol";
import ProviderOptionsEditor from "./ProviderOptionsEditor.svelte";
import RecoveryModelControl from "./RecoveryModelControl.svelte";

interface Props {
	recovery: StartupRecoverySummary;
	instanceId: string;
	modelProfiles?: readonly ModelProfileOptionSummary[];
	defaultModelProfileId?: string | null;
	busy?: boolean;
	error?: string | null;
	onRetry: (
		startRecordId: string,
		nextTurnModelProfileId?: string | null,
		providerOptions?: Readonly<Record<string, string>>,
	) => void;
}

let {
	recovery,
	instanceId,
	modelProfiles = [],
	defaultModelProfileId = null,
	busy = false,
	error = null,
	onRetry,
}: Props = $props();

let modelProfileDraft = $state((() => defaultModelProfileId ?? "")());
let providerOptionsDraft = $state<Record<string, string> | undefined>(undefined);
const selectedProfile = $derived(
	modelProfiles.find((profile) => profile.id === modelProfileDraft) ?? null,
);
const selectedModelUsable = $derived(
	selectedProfile === null ||
		selectedProfile.availability === undefined ||
		selectedProfile.availability === "available",
);
</script>

<section class="startup-recovery" data-section="startup-recovery" tabindex="-1">
	<p class="eyebrow">Startup error</p>
	<h3>{recovery.title}</h3>
	<p>{recovery.summary}</p>
	{#if recovery.guidance}<p class="guidance">{recovery.guidance}</p>{/if}
	{#if recovery.technicalDetail}
		<details>
			<summary>Technical details</summary>
			<pre>{recovery.technicalDetail}</pre>
		</details>
	{/if}
	<RecoveryModelControl
		{instanceId}
		{modelProfiles}
		defaultModelProfileId={defaultModelProfileId ?? null}
		initialProviderOptions={recovery.providerOptions}
		disabled={busy}
		selectId={`startup-model-${recovery.startRecordId}`}
		selectLabel="Model"
		selectDataField="startup-recovery-model"
		onModelChange={(profileId) => {
			modelProfileDraft = profileId ?? "";
		}}
		onProviderOptionsChange={(values) => (providerOptionsDraft = values ? { ...values } : undefined)}
	/>
	<button
		type="button"
		data-action="retry-startup"
		data-start-record-id={recovery.startRecordId}
		disabled={busy || !selectedModelUsable || (recovery.action === "choose_model" && !modelProfileDraft)}
		onclick={() =>
			onRetry(recovery.startRecordId, modelProfileDraft || undefined, providerOptionsDraft)}
	>
		{busy
			? "Retrying…"
			: recovery.action === "choose_model"
				? "Choose model and retry startup"
				: "Retry startup"}
	</button>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
	.startup-recovery {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 20px 22px;
		border: 1px solid color-mix(in srgb, var(--chronicle-danger) 34%, var(--chronicle-border));
		border-radius: 20px;
		background: color-mix(in srgb, var(--chronicle-danger) 6%, var(--chronicle-card-surface));
	}

	.eyebrow,
	h3,
	p {
		margin: 0;
	}

	.eyebrow {
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		color: var(--chronicle-danger);
	}

	.guidance {
		color: var(--chronicle-muted);
	}

	button {
		border: 1px solid var(--chronicle-border);
		border-radius: 10px;
		padding: 10px 12px;
		background: var(--chronicle-card-surface);
		color: inherit;
	}

	button {
		align-self: flex-start;
		font-weight: 700;
		cursor: pointer;
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.58;
	}

	pre {
		white-space: pre-wrap;
	}

	.error {
		color: var(--chronicle-danger);
	}
</style>
