<script lang="ts">
import type { ModelProfileOptionSummary } from "@leitwerk-dev/protocol";
import ModelProfileOptions from "./ModelProfileOptions.svelte";
import ProviderOptionsEditor from "./ProviderOptionsEditor.svelte";

interface Props {
	instanceId: string;
	modelProfiles: readonly ModelProfileOptionSummary[];
	defaultModelProfileId: string | null;
	initialProviderOptions?: Readonly<Record<string, string>>;
	disabled: boolean;
	selectId: string;
	selectLabel?: string;
	selectDataField?: string;
	onModelChange: (profileId: string | undefined, usable: boolean) => void;
	onProviderOptionsChange: (values: Record<string, string> | undefined) => void;
}

let {
	instanceId,
	modelProfiles,
	defaultModelProfileId,
	initialProviderOptions = {},
	disabled,
	selectId,
	selectLabel = "Model",
	selectDataField = "recovery-model",
	onModelChange,
	onProviderOptionsChange,
}: Props = $props();

let modelProfileDraft = $state((() => defaultModelProfileId ?? "")());

const selectedProfile = $derived(
	modelProfiles.find((profile) => profile.id === modelProfileDraft) ?? null,
);
const selectedModelUsable = $derived(
	selectedProfile === null ||
		selectedProfile.availability === undefined ||
		selectedProfile.availability === "available",
);

$effect(() => {
	onModelChange(modelProfileDraft || undefined, selectedModelUsable);
});
</script>

{#if modelProfiles.length > 0}
	<label class="model-label" for={selectId}>{selectLabel}</label>
	<select
		id={selectId}
		class="model-select"
		data-field={selectDataField}
		bind:value={modelProfileDraft}
		{disabled}
	>
		<ModelProfileOptions profiles={modelProfiles} />
	</select>
	{#if selectedProfile?.safeReason && !selectedModelUsable}
		<p class="model-reason">{selectedProfile.safeReason}</p>
	{/if}
{/if}
<ProviderOptionsEditor
	{instanceId}
	modelProfileId={modelProfileDraft || null}
	initialValues={initialProviderOptions}
	{disabled}
	onChange={(values) => onProviderOptionsChange(values ? { ...values } : undefined)}
/>

<style>
	.model-label {
		font-size: 13px;
		font-weight: 750;
		letter-spacing: 0.01em;
		color: var(--chronicle-text);
	}

	.model-select {
		width: 100%;
		border: 1px solid var(--chronicle-border);
		border-radius: 10px;
		background: var(--chronicle-card-surface);
		color: inherit;
		padding: 10px 12px;
	}

	.model-reason {
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--chronicle-text-muted);
		max-width: 58ch;
	}
</style>
