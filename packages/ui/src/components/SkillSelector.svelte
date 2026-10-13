<script lang="ts">
import type { SkillOptionSummary } from "@leitwerk-dev/protocol";

interface Props {
	skills: readonly SkillOptionSummary[];
	selectedIds?: string[];
	id?: string;
	invalid?: boolean;
	describedBy?: string;
	onSelectionChange?: () => void;
}

let {
	skills,
	selectedIds = $bindable([]),
	id = undefined,
	invalid = false,
	describedBy = undefined,
	onSelectionChange = undefined,
}: Props = $props();
</script>

<fieldset {id} tabindex="-1" data-invalid={invalid} aria-describedby={describedBy} class="skill-selector" data-section="launcher-skills">
	<legend class="field-label">Skills</legend>
	<p class="field-description">Make selected skills available to every AI step in this run.</p>
	{#each skills as skill (skill.id)}
		<label class="skill-option">
			<input type="checkbox" aria-invalid={invalid} aria-describedby={describedBy} value={skill.id} bind:group={selectedIds} onchange={onSelectionChange} />
			<span>
				<strong>{skill.label}</strong>
				{#if skill.description}<small>{skill.description}</small>{/if}
			</span>
		</label>
	{/each}
</fieldset>

<style>
	.skill-selector[data-invalid="true"] { outline: 1px solid var(--chronicle-danger); outline-offset: 4px; }
	.skill-selector {
		border: 0;
		padding: 0;
		margin: 1.25rem 0;
	}

	.skill-option {
		display: flex;
		gap: 0.65rem;
		align-items: flex-start;
		margin: 0.65rem 0;
	}

	.skill-option small {
		display: block;
		color: var(--color-text-muted, #667085);
		margin-top: 0.15rem;
	}
</style>
