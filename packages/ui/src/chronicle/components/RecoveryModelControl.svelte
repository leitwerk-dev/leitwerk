<script lang="ts">
import type { ModelProfileOptionSummary } from "@leitwerk-dev/protocol";
import { recoveryModelSelection } from "../lib/recovery-model.js";
import ModelProfileOptions from "./ModelProfileOptions.svelte";
import ProviderOptionsEditor from "./ProviderOptionsEditor.svelte";

interface Props {
	instanceId: string;
	modelProfiles: readonly ModelProfileOptionSummary[];
	defaultModelProfileId: string | null;
	inheritedModelProfileId?: string | null;
	initialProviderOptions?: Readonly<Record<string, string>>;
	disabled: boolean;
	selectId: string;
	selectLabel?: string;
	selectDataField?: string;
	onModelChange: (profileId: string | null | undefined, usable: boolean) => void;
	onProviderOptionsChange: (values: Record<string, string> | undefined) => void;
}

let {
	instanceId,
	modelProfiles,
	defaultModelProfileId,
	inheritedModelProfileId = null,
	initialProviderOptions = {},
	disabled,
	selectId,
	selectLabel = "Model",
	selectDataField = "recovery-model",
	onModelChange,
	onProviderOptionsChange,
}: Props = $props();

let modelProfileDraft = $state("");

const draft = $derived(modelProfileDraft === "__inherit" ? null : modelProfileDraft || undefined);
const selection = $derived(
	recoveryModelSelection(modelProfiles, draft, defaultModelProfileId, inheritedModelProfileId),
);

$effect(() => {
	onModelChange(draft, selection.usable);
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
		<option value="">Use current model policy{defaultModelProfileId ? ` (${defaultModelProfileId})` : ""}</option>
		<option value="__inherit">Use inherited value{inheritedModelProfileId ? ` (${inheritedModelProfileId})` : ""}</option>
		<ModelProfileOptions profiles={modelProfiles} />
	</select>
	{#if selection.profile?.safeReason && !selection.usable}
		<p class="model-reason">{selection.profile.safeReason}</p>
	{/if}
{/if}
<ProviderOptionsEditor
	{instanceId}
	modelProfileId={selection.profileId}
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
