<script lang="ts">
import type { ModelProviderOptionsResponseBody } from "@leitwerk-dev/protocol";
import { fetchModelProviderOptions } from "../../lib/api.js";

interface Props {
	instanceId: string;
	modelProfileId: string | null;
	initialValues?: Readonly<Record<string, string>>;
	disabled?: boolean;
	onChange: (values: Readonly<Record<string, string>> | undefined) => void;
}

let {
	instanceId,
	modelProfileId,
	initialValues = {},
	disabled = false,
	onChange,
}: Props = $props();

let catalog = $state.raw<ModelProviderOptionsResponseBody | null>(null);
let values = $state<Record<string, string>>({});
let loading = $state(false);
let error = $state<string | null>(null);
let requestGeneration = 0;

function applyCatalog(nextCatalog: ModelProviderOptionsResponseBody) {
	const nextValues: Record<string, string> = {};
	for (const field of nextCatalog.fields) {
		const previous = initialValues[field.id];
		if (previous !== undefined) {
			nextValues[field.id] = previous;
		} else if (field.defaultValue !== null) {
			nextValues[field.id] = field.defaultValue;
		}
	}
	values = nextValues;
	onChange({ ...nextValues });
}

async function load(profileId: string, generation: number) {
	loading = true;
	error = null;
	try {
		const result = await fetchModelProviderOptions(instanceId, profileId);
		if (generation !== requestGeneration || modelProfileId !== profileId) return;
		catalog = result;
		applyCatalog(result);
	} catch (cause) {
		if (generation !== requestGeneration || modelProfileId !== profileId) return;
		error = cause instanceof Error ? cause.message : "Couldn't load provider options";
	} finally {
		if (generation === requestGeneration) loading = false;
	}
}

function setValue(fieldId: string, value: string, required: boolean) {
	const next = { ...values };
	if (value === "" && !required) delete next[fieldId];
	else next[fieldId] = value;
	values = next;
	onChange({ ...next });
}

function handleToggle(event: Event) {
	const details = event.currentTarget as HTMLDetailsElement;
	const profileId = modelProfileId;
	if (!details.open || !profileId || catalog || loading) return;
	requestGeneration += 1;
	void load(profileId, requestGeneration);
}

$effect(() => {
	modelProfileId;
	requestGeneration += 1;
	catalog = null;
	values = {};
	error = null;
	loading = false;
	onChange(undefined);
});
</script>

{#if modelProfileId}
	<details class="provider-options" data-section="provider-options" ontoggle={handleToggle}>
		<summary>Advanced provider options</summary>
		{#if loading}
			<p class="muted">Loading current provider options…</p>
		{:else if error}
			<p class="error" role="alert">{error}</p>
		{:else if catalog && catalog.fields.length === 0}
			<p class="muted">This provider has no per-start options.</p>
		{:else if catalog}
			{#if catalog.choicesUnavailableReason}
				<p class="muted">{catalog.choicesUnavailableReason}. You can still enter a value.</p>
			{/if}
			<div class="fields">
				{#each catalog.fields as field (field.id)}
					<label>
						<span>{field.label}{field.required ? " (required)" : ""}</span>
						<input
							list={field.choices.length > 0 ? `provider-options-${catalog.modelProfileId}-${field.id}` : undefined}
							value={values[field.id] ?? ""}
							required={field.required}
							minlength={field.minLength ?? undefined}
							maxlength={field.maxLength ?? undefined}
							{disabled}
							oninput={(event) =>
								setValue(field.id, event.currentTarget.value, field.required)}
						/>
						{#if field.choices.length > 0}
							<datalist id={`provider-options-${catalog.modelProfileId}-${field.id}`}>
								{#each field.choices as choice (choice.value)}
									<option value={choice.value}>{choice.label}</option>
								{/each}
							</datalist>
						{/if}
					</label>
				{/each}
			</div>
			<p class="muted">Suggestions are advisory; another structurally valid value is allowed.</p>
		{/if}
	</details>
{/if}

<style>
	.provider-options {
		width: 100%;
		border: 1px solid var(--chronicle-border);
		border-radius: 10px;
		padding: 10px 12px;
	}

	summary {
		cursor: pointer;
		font-weight: 700;
	}

	.fields {
		display: grid;
		gap: 10px;
		margin-top: 12px;
	}

	label {
		display: grid;
		gap: 6px;
	}

	input {
		border: 1px solid var(--chronicle-border);
		border-radius: 8px;
		padding: 9px 10px;
		background: var(--chronicle-card-surface);
		color: inherit;
	}

	.muted,
	.error {
		margin: 10px 0 0;
		font-size: 0.82rem;
	}

	.muted {
		color: var(--chronicle-muted);
	}

	.error {
		color: var(--chronicle-danger);
	}
</style>
