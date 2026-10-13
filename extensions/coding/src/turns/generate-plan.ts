import type { FlowPromptContext, StructuralProcessState } from "@leitwerk-dev/process-sdk";

/** @internal */
export function buildGeneratePlanPrompt(
	ctx: FlowPromptContext<unknown, StructuralProcessState, never>,
): string {
	return `Create one coordinated implementation plan for this change:
${ctx.prompts.initial}

Repository checkouts: ${ctx.repo
		.all()
		.map((repo) => `${repo.key}: ${repo.fsPath}`)
		.join("; ")}

Planning completion:
- inspect relevant code, repository guidance, dependency contracts, and external references before selecting the implementation
- resolve questions affecting correctness, compatibility, or feasibility during planning; published steps must describe decided changes and validation after those changes, with no required investigation deferred to implementation
- verify access to the resources needed to establish those decisions; never assume implementation will receive additional access
- after exhausting discoverable facts, use ask_questions for material operator decisions when available and await the answers before finishing the plan
- when questions are disabled, make those decisions from the requirement and evidence, record minimal assumptions, and keep the requested scope
- if required evidence remains inaccessible, call abort_turn with the resource, observed failure, and access needed to continue; do not publish a conditional successful plan
- call plan_saved only after required investigation and access are complete and design-critical questions are resolved

Plan format:
- use three default sections: Findings and decisions, Changes, and Validation
- for straightforward tickets, target 150–300 words; add detail when complexity requires it
- Findings and decisions: state what investigation established beyond the ticket, including exact locations, the selected approach, compatibility requirements, and behavior already satisfying the requirements
- Changes: describe concrete edits by affected component; label repository-specific work when planning across multiple repositories
- Validation: group related checks that verify the decided changes
- avoid repeating the ticket, duplicating acceptance criteria, or adding generic preservation and completion sections
- include snippets only when they resolve a meaningful implementation ambiguity

Inspection rules:
- follow each repository's instructions
- use bash only for read-only inspection (e.g. git log, git diff, rg, tree, file listing, read-only http/CLI calls)
- do not modify files, commit, or push
- keep the number of changed files small`;
}
