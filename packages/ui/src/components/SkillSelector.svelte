<script lang="ts">
import type { SkillOptionSummary } from "@leitwerk-dev/protocol";

interface Props {
	skills: readonly SkillOptionSummary[];
	selectedIds?: string[];
}

let { skills, selectedIds = $bindable([]) }: Props = $props();
</script>

<fieldset class="skill-selector" data-section="launcher-skills">
	<legend class="field-label">Skills</legend>
	<p class="field-description">Make selected skills available to every AI step in this run.</p>
	{#each skills as skill (skill.id)}
		<label class="skill-option">
			<input type="checkbox" value={skill.id} bind:group={selectedIds} />
			<span>
				<strong>{skill.label}</strong>
				{#if skill.description}<small>{skill.description}</small>{/if}
			</span>
		</label>
	{/each}
</fieldset>

<style>
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
