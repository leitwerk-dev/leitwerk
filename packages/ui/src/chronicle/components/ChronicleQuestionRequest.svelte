<script lang="ts">
import {
	emptyQuestionDrafts,
	type ProcessQuestionRequest,
	type QuestionAnswerDraft,
} from "@leitwerk-dev/domain";
import { untrack } from "svelte";
import { submitQuestionAnswers } from "../../lib/api.js";

let { request }: { request: ProcessQuestionRequest } = $props();
let draft = $state(untrack(() => emptyQuestionDrafts(request.questions)));
let submitError = $state<string | null>(null);
let submitting = $state(false);

const unanswered = $derived(
	draft.map((answer) => answer.selectedOptionIds.length === 0 && answer.freeText.trim() === ""),
);
const canSubmit = $derived(
	request.status === "open" && !submitting && unanswered.every((value) => !value),
);

function updateDraft(index: number, patch: Partial<QuestionAnswerDraft>) {
	draft[index] = { ...draft[index], ...patch };
}

function toggleOption(questionIndex: number, optionId: string, checked: boolean) {
	const question = request.questions[questionIndex];
	const answer = draft[questionIndex];
	const selectedOptionIds =
		question.selection === "single"
			? checked
				? [optionId]
				: []
			: checked
				? [...new Set([...answer.selectedOptionIds, optionId])]
				: answer.selectedOptionIds.filter((id) => id !== optionId);
	updateDraft(questionIndex, { selectedOptionIds });
}

async function submit() {
	submitError = null;
	if (!canSubmit) return;
	submitting = true;
	try {
		request = await submitQuestionAnswers({
			instanceId: request.instanceId,
			requestId: request.id,
			draft,
		});
	} catch (error) {
		submitError = error instanceof Error ? error.message : "Answers could not be sent. Try again.";
	} finally {
		submitting = false;
	}
}
</script>

<section class="question-request" id={`question-request-${request.id}`} data-question-request-id={request.id}>
	<div class="question-heading">
		<h4>{request.status === "open" ? "Waiting for your answers" : request.status === "answered" ? "Questions answered" : "Question request interrupted"}</h4>
		<p>{request.status === "open" ? "The active turn will continue here after you send the complete set." : "This durable record belongs to the turn’s reasoning history."}</p>
	</div>

	{#if request.status === "open"}
	<form onsubmit={(event) => { event.preventDefault(); void submit(); }} novalidate>
		{#each request.questions as question, questionIndex (question.id)}
			<fieldset data-question-index={questionIndex} aria-describedby={`question-help-${question.id}`}>
				<legend>
					{#if request.questions.length > 1}<span>{questionIndex + 1}.</span>{/if}
					{question.question}
				</legend>
				<p id={`question-help-${question.id}`} class="selection-help">
					{question.selection === "single" ? "Choose one option or write another answer." : "Choose one or more options, or write another answer."}
				</p>
				<div class="options">
					{#each question.options as option (option.id)}
						<label class="option-row">
							<input
								type={question.selection === "single" ? "radio" : "checkbox"}
								name={`question-${request.id}-${question.id}`}
								checked={draft[questionIndex].selectedOptionIds.includes(option.id)}
								disabled={submitting}
								onchange={(event) => toggleOption(questionIndex, option.id, event.currentTarget.checked)}
							/>
							<span class="option-copy">
								<strong>{option.label}</strong>
								{#if option.details}<span>{option.details}</span>{/if}
							</span>
						</label>
					{/each}
				</div>
				<label class="text-field">
					<span>Write another answer</span>
					<textarea
						rows="2"
						value={draft[questionIndex].freeText}
						disabled={submitting}
						oninput={(event) => updateDraft(questionIndex, { freeText: event.currentTarget.value })}
					></textarea>
				</label>
				<label class="text-field">
					<span>Add context <small>Optional</small></span>
					<textarea
						rows="2"
						value={draft[questionIndex].comment}
						disabled={submitting}
						oninput={(event) => updateDraft(questionIndex, { comment: event.currentTarget.value })}
					></textarea>
				</label>
			</fieldset>
		{/each}

		{#if submitError}<p class="submit-error" role="alert">{submitError}</p>{/if}
		<div class="submit-row">
			<button class="submit-button" type="submit" disabled={!canSubmit}>
				{submitting ? "Sending answers…" : "Send answers"}
			</button>
			{#if !canSubmit && !submitting}<p>Answer every question to continue.</p>{/if}
		</div>
	</form>
	{:else}
		<div class="answer-summary" role="status">
			<p>{request.status === "answered" ? "Answers sent. The turn is continuing." : "This request can no longer be answered."}</p>
			{#each request.questions as question, index (question.id)}
				<div>
					<strong>{question.question}</strong>
					<p>{request.answers?.[index] ?? "Not answered"}</p>
				</div>
			{/each}
		</div>
	{/if}
</section>

<style>
	.question-request { display: flex; flex-direction: column; gap: 18px; padding-top: 4px; }
	.question-heading { display: grid; gap: 4px; }
	.question-heading h4 { margin: 0 0 4px; font: 700 18px/1.25 var(--font-display); color: var(--chronicle-text); }
	.question-heading p, .submit-row p, .selection-help { margin: 0; color: var(--chronicle-text-muted); font-size: 14px; line-height: 1.5; }
	.submit-error { margin: 0; padding: 11px 12px; border: 1px solid var(--chronicle-danger-border); border-radius: 14px; background: var(--chronicle-danger-surface-soft); color: var(--chronicle-danger-text); font-size: 14px; }
	form { display: flex; flex-direction: column; gap: 22px; }
	fieldset { min-width: 0; margin: 0; padding: 0 0 22px; border: 0; border-bottom: 1px solid var(--chronicle-border); }
	legend { padding: 0; color: var(--chronicle-text); font-size: 14px; font-weight: 700; line-height: 1.45; }
	legend span { display: inline-block; min-width: 24px; color: var(--chronicle-accent); }
	.selection-help { margin-top: 5px; }
	.options { display: grid; gap: 8px; margin-top: 12px; }
	.option-row { display: grid; grid-template-columns: 22px 1fr; gap: 10px; min-height: 44px; align-items: start; padding: 10px 12px; border: 1px solid var(--chronicle-border); border-radius: 14px; background: var(--chronicle-card-surface); cursor: pointer; }
	.option-row:hover { border-color: color-mix(in srgb, var(--chronicle-accent) 42%, var(--chronicle-border)); }
	.option-row:has(input:checked) { border-color: color-mix(in srgb, var(--chronicle-accent) 55%, var(--chronicle-border)); background: color-mix(in srgb, white 88%, var(--chronicle-accent-soft) 12%); }
	.option-row input { width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--chronicle-accent); }
	.option-copy { display: flex; flex-direction: column; gap: 2px; line-height: 1.4; color: var(--chronicle-text); }
	.option-copy strong { font-size: 14px; font-weight: 650; }
	.option-copy > span { font-size: 14px; color: var(--chronicle-text-muted); }
	.text-field { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; color: var(--chronicle-text); font-size: 14px; font-weight: 650; }
	.text-field small { color: var(--chronicle-text-faint); font: inherit; font-weight: 450; }
	textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 52px; padding: 10px 12px; border: 1px solid var(--chronicle-border); border-radius: 14px; background: var(--chronicle-card-surface); color: var(--chronicle-text); font: inherit; line-height: 1.45; }
	textarea:focus-visible, input:focus-visible, button:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 2px; }
	.answer-summary { display: grid; gap: 14px; color: var(--chronicle-text); }
	.answer-summary > p, .answer-summary div p { margin: 0; white-space: pre-wrap; font-size: 14px; line-height: 1.5; color: var(--chronicle-text-muted); }
	.answer-summary div { display: grid; gap: 4px; }
	.submit-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
	.submit-button { min-height: 44px; padding: 0 18px; border: 0; border-radius: 999px; background: var(--chronicle-text); color: white; font: inherit; font-weight: 700; cursor: pointer; }
	.submit-button:disabled { cursor: default; opacity: .45; }
	@media (max-width: 640px) {
		.submit-button { width: 100%; }
		.option-row { padding: 11px 10px; }
	}
</style>
