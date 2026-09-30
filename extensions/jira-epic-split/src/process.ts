import { asUnknownRecord } from "@leitwerk-dev/domain";
import type { JiraIssue } from "@leitwerk-dev/jira";
import {
	type AutomaticOutcomeBuilder,
	type Codec,
	flow,
	type ProcessLauncherDefinition,
	type ProcessWatcherSource,
	wikiInstructions,
} from "@leitwerk-dev/process-sdk";
import {
	batchMarkdown,
	initialSplitState,
	parseDraft,
	type SplitDraft,
	type SplitParams,
	type SplitRepository,
	type SplitState,
	splitParamsCodec,
	splitStateCodec,
} from "./model.js";
import { parseLabels } from "./services.js";

interface PreparedBatch {
	drafts: SplitDraft[];
	epic: JiraIssue;
	epicRevision: string;
}
const inspectionTools = [
	"gitlab_inspect_project",
	"gitlab_repository_tree",
	"gitlab_repository_file",
	"wiki_index",
	"wiki_read",
	"wiki_share",
];
const draftShape =
	"{repositoryKey, verdict: applicable|not_applicable|already_compliant|unresolved, reason, evidence, revision: inspected commit SHA, summary, description: detailed change and acceptance criteria, issueType: Story|Task|Sub-task}";
const repositoryCodec: Codec<SplitRepository> = {
	parse: (value) => value as SplitRepository,
	serialize: (value) => value,
};
const draftCodec: Codec<SplitDraft> = { parse: parseDraft, serialize: (value) => value };

function publicationState(state: SplitState, input: unknown): SplitState {
	const results = input as {
		repositoryKey: string;
		receipt?: SplitDraft["receipt"];
		reviewRequired?: string;
	}[];
	return {
		...state,
		approved: [],
		drafts: state.drafts.map((draft) => {
			const result = results.find((candidate) => candidate.repositoryKey === draft.repositoryKey);
			return result?.receipt
				? { ...draft, receipt: result.receipt }
				: result?.reviewRequired
					? { ...draft, blocked: result.reviewRequired }
					: draft;
		}),
	};
}

function recordPublication(outcome: AutomaticOutcomeBuilder<SplitParams, SplitState>) {
	return outcome
		.parameter("results", {
			type: "array",
			description: "Publication receipts",
			items: { type: "object" },
		})
		.effect(({ ctx, event }) => ({ state: publicationState(ctx.state, event.params.results) }));
}

/** @internal */
export function createSplitProcess(
	launcher: ProcessLauncherDefinition<SplitParams>,
	watcher: {
		source: ProcessWatcherSource<Record<string, unknown>, Record<string, unknown>>;
		resolve: (
			event: Record<string, unknown>,
		) => Promise<import("@leitwerk-dev/process-sdk").ProcessLaunchConfig<SplitParams>>;
	},
) {
	return flow
		.process<SplitParams, SplitState>("jira_epic_split_process")
		.displayName("Jira Issue Split")
		.entry("read_epic")
		.runtime({ repositoryCheckout: "on_demand" })
		.codecs({ params: splitParamsCodec, state: splitStateCodec })
		.initialState(initialSplitState)
		.launcher(launcher)
		.watcher({
			id: "epic_split",
			label: "Jira issue splitting",
			description:
				"Split issues labeled leitwerk-issue-split or leitwerk-epic-split into repository tickets",
			source: watcher.source,
			resolveLaunchConfig: watcher.resolve,
		})
		.repositoryCredentials(({ params, projects }) =>
			projects.map((project) => ({
				projectKey: project.key,
				kind: "git_ssh" as const,
				credentialRef: params.sshProfile,
			})),
		)
		.happyPath(
			"read_epic",
			"discover_candidates",
			"assess_repository",
			"prepare_review",
			"batch_review",
			"publish_tickets",
			"complete_split",
		)
		.turn(
			flow
				.automatic<SplitParams, SplitState>("read_epic")
				.description("Read source issue")
				.integrationTools("jira_split_prepare")
				.run(async (ctx) => ({
					outcome: "read",
					params: { prepared: await ctx.callIntegrationTool("jira_split_prepare", {}) },
				}))
				.outcome("read", (outcome) =>
					outcome
						.description("Source issue captured")
						.parameter("prepared", { type: "object", description: "Captured source issue" })
						.effect(({ ctx, event }) => {
							const prepared = event.params.prepared as PreparedBatch;
							return {
								state: { ...ctx.state, epic: prepared.epic, epicRevision: prepared.epicRevision },
							};
						})
						.to("discover_candidates"),
				),
		)
		.turn(
			flow
				.llm<SplitParams, SplitState>("discover_candidates")
				.description("Discover repository candidates")
				.freshPrimary()
				.tools("read", "bash")
				.integrationTools(...inspectionTools)
				.askQuestions()
				.buildPrompt(
					(ctx) =>
						`Read the source issue and identify repository candidates for its requirements. Inspect GitLab metadata/files; checkout_repository is available when needed. Every scoped repository needs a reasoned decision. Inaccessible or ambiguous repositories remain candidates for investigation; never silently exclude them. Inspection only: no code changes or pushes.\n${wikiInstructions}\nSource issue: ${JSON.stringify(ctx.state.epic)}\nRepositories: ${JSON.stringify(ctx.params.repositories)}`,
				)
				.outcomeTool("candidates_identified", (outcome) =>
					outcome
						.description("Record all discovery decisions")
						.requiredString(
							"decisions",
							"JSON array: one {repositoryKey,candidate:boolean,reason} per scoped repository",
						)
						.effect(({ ctx, event }) => {
							const decisions = JSON.parse(String(event.params.decisions)) as {
								repositoryKey: string;
								candidate: boolean;
								reason: string;
							}[];
							if (
								!Array.isArray(decisions) ||
								decisions.length !== ctx.params.repositories.length ||
								new Set(decisions.map((decision) => decision.repositoryKey)).size !==
									decisions.length ||
								decisions.some(
									(decision) =>
										!ctx.params.repositories.some(
											(repository) => repository.key === decision.repositoryKey,
										) ||
										typeof decision.candidate !== "boolean" ||
										typeof decision.reason !== "string" ||
										!decision.reason.trim(),
								)
							)
								throw new Error("Provide one evidence-based decision for every scoped repository");
							return {
								state: {
									...ctx.state,
									candidates: decisions
										.filter((decision) => decision.candidate)
										.map((decision) => decision.repositoryKey),
									drafts: decisions
										.filter((decision) => !decision.candidate)
										.map((decision) =>
											parseDraft({
												...decision,
												verdict: "not_applicable",
												evidence: decision.reason,
												issueType: ctx.params.issueType,
											}),
										),
								},
							};
						})
						.to("assess_repository"),
				),
		)
		.turn(
			flow
				.llm<SplitParams, SplitState>("assess_repository")
				.description("Assess repository applicability")
				.freshPrimary()
				.tools("read", "bash")
				.integrationTools(...inspectionTools)
				.askQuestions()
				.forEach<SplitRepository, SplitDraft>({
					items: ({ params, state }) =>
						params.repositories.filter((repository) => state.candidates.includes(repository.key)),
					itemCodec: repositoryCodec,
					resultCodec: draftCodec,
					key: ({ item }) => item.key,
					label: ({ item }) => item.name,
				})
				.buildPrompt(
					(ctx) =>
						`Determine whether this repository needs changes for the source issue's requirements. Use GitLab file reads and checkout_repository as needed. Do not change code or publish anything. Distinguish already compliant, not applicable, and unresolved; lack of access is unresolved. For an applicable repository prepare one ticket with concrete acceptance criteria, evidence and inspected commit. ${ctx.params.subtaskType ? `Use issueType Sub-task (${ctx.params.subtaskType.name}); Story and Task are not allowed.` : `Default issue type: ${ctx.params.issueType}; only Story or Task are allowed.`}\n${wikiInstructions}\nSource issue: ${JSON.stringify(ctx.state.epic)}\nRepository: ${JSON.stringify(ctx.item)}\nReturn assessment JSON: ${draftShape}`,
				)
				.outcomeTool("repository_assessed", (outcome) =>
					outcome
						.description("Save repository assessment and draft")
						.requiredString("assessment", `JSON ${draftShape}`)
						.yield(({ ctx, event }) => {
							const draft = parseDraft(JSON.parse(String(event.params.assessment)), ctx.params);
							if (draft.repositoryKey !== ctx.item.key)
								throw new Error("Assessment repository mismatch");
							return draft;
						}),
				)
				.collect(({ state }, results) => ({
					...state,
					drafts: [...state.drafts, ...results],
					candidates: [],
				}))
				.to("prepare_review"),
		)
		.turn(
			flow
				.automatic<SplitParams, SplitState>("prepare_review")
				.description("Prepare ticket batch")
				.integrationTools("jira_split_prepare")
				.run(async (ctx) => {
					const prepared = (await ctx.callIntegrationTool(
						"jira_split_prepare",
						{},
					)) as PreparedBatch;
					return {
						outcome: "ready",
						params: {
							prepared,
							batch: batchMarkdown(ctx.params, { ...ctx.state, drafts: prepared.drafts }),
						},
					};
				})
				.outcome("ready", (outcome) =>
					outcome
						.description("Batch ready for review")
						.parameter("prepared", {
							type: "object",
							description: "Current mappings and source issue",
						})
						.markdown("batch", { publish: true })
						.effect(({ ctx, event }) => {
							const prepared = event.params.prepared as PreparedBatch;
							return {
								state: { ...ctx.state, drafts: prepared.drafts, epic: prepared.epic, approved: [] },
							};
						})
						.to("batch_review"),
				),
		)
		.turn(
			flow
				.human<SplitParams, SplitState>("batch_review")
				.description("Review repository tickets")
				.reviewProduct("batch")
				.action("approve_batch", (action) =>
					action
						.label("Create approved tickets")
						.form({
							id: "split_approval",
							title: "Publish repository tickets",
							submitLabel: "Create tickets",
							fields: [
								{
									id: "exclude",
									label: "Repositories to exclude",
									kind: "textarea",
									description:
										"One repository path per line. Unresolved rows stay pending unless explicitly excluded.",
								},
								{
									id: "tasks",
									label: "Create as Tasks",
									kind: "textarea",
									description:
										"Epic splits only: optional repository paths, one per line. Leave blank for subtask splits.",
								},
								{
									id: "labels",
									label: "Ticket labels",
									kind: "text",
									primaryPrompt: true,
									description:
										"Comma-separated labels. Include use-leitwerk only to start code changes. Blank keeps the displayed labels.",
								},
								{ id: "clearLabels", label: "Remove all selected ticket labels", kind: "boolean" },
							],
						})
						.effect(({ ctx, input }) => {
							const keys = (value: unknown) => {
								const names =
									typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : [];
								return names.map((name) => {
									const repository = ctx.params.repositories.find(
										(candidate) => candidate.name === name,
									);
									if (!repository) throw new Error(`Unknown repository: ${name}`);
									return repository.key;
								});
							};
							const excluded = keys(input.exclude),
								tasks = keys(input.tasks);
							if (ctx.params.subtaskType && tasks.length)
								throw new Error(
									"Subtask splits cannot create Tasks; leave the Task overrides blank",
								);
							const drafts = ctx.state.drafts.map((draft) =>
								draft.receipt
									? draft
									: {
											...draft,
											excluded: draft.excluded || excluded.includes(draft.repositoryKey),
											issueType: tasks.includes(draft.repositoryKey)
												? ("Task" as const)
												: draft.issueType,
										},
							);
							const labels =
								input.clearLabels === true
									? []
									: typeof input.labels === "string" && input.labels.trim()
										? parseLabels(input.labels)
										: ctx.state.labels;
							return {
								state: {
									...ctx.state,
									drafts,
									labels,
									approved: drafts
										.filter(
											(draft) =>
												draft.verdict === "applicable" &&
												!draft.blocked &&
												!draft.excluded &&
												!draft.receipt,
										)
										.map((draft) => draft.repositoryKey),
								},
							};
						})
						.to("publish_tickets"),
				)
				.action("revise_batch", (action) =>
					action
						.label("Revise tickets or assessments")
						.form({
							id: "split_revision",
							title: "Revise batch",
							fields: [
								{
									id: "message",
									label: "Instructions",
									kind: "textarea",
									required: true,
									primaryPrompt: true,
								},
							],
						})
						.effect(({ ctx, input }) => ({
							state: { ...ctx.state, feedback: String(input.message ?? ""), approved: [] },
						}))
						.to("revise_drafts"),
				)
				.action("refresh_mappings", (action) =>
					action.label("Refresh component mappings").to("prepare_review"),
				)
				.action("exclude_remaining", (action) =>
					action
						.label("Finish without remaining tickets")
						.effect(({ ctx }) => ({
							state: {
								...ctx.state,
								approved: [],
								drafts: ctx.state.drafts.map((draft) =>
									draft.receipt ? draft : { ...draft, excluded: true },
								),
							},
						}))
						.to("complete_split"),
				),
		)
		.turn(
			flow
				.llm<SplitParams, SplitState>("revise_drafts")
				.description("Revise the ticket batch")
				.tools("read", "bash")
				.integrationTools(...inspectionTools, "jira_split_prepare")
				.prepare(
					async (ctx) => (await ctx.callIntegrationTool("jira_split_prepare", {})) as PreparedBatch,
				)
				.buildPrompt(
					(ctx) =>
						`Revise the unpublished repository assessments and ticket drafts using the operator feedback. Reinspect when the source issue or evidence changed. Preserve published rows and repository identities. Return every unpublished row in drafts JSON. ${ctx.params.subtaskType ? "Use issueType Sub-task for every row." : "Use issueType Story or Task for every row."} Do not create issues. ${wikiInstructions}\nSource issue: ${JSON.stringify(ctx.prepared.epic)}\nFeedback: ${ctx.state.feedback}\nRepositories: ${JSON.stringify(ctx.params.repositories)}\nCurrent drafts: ${JSON.stringify(ctx.state.drafts)}\nEach draft has shape ${draftShape}`,
				)
				.outcomeTool("drafts_revised", (outcome) =>
					outcome
						.description("Replace unpublished drafts")
						.requiredString("drafts", "JSON array of all unpublished repository drafts")
						.effect(({ ctx, event }) => {
							const value: unknown = JSON.parse(String(event.params.drafts));
							if (!Array.isArray(value)) throw new Error("Expected draft array");
							const drafts = value.map((draft) => parseDraft(draft, ctx.params));
							const pending = ctx.state.drafts.filter((draft) => !draft.receipt);
							if (
								drafts.length !== pending.length ||
								new Set(drafts.map((draft) => draft.repositoryKey)).size !== drafts.length ||
								drafts.some(
									(draft) => !pending.some((old) => old.repositoryKey === draft.repositoryKey),
								)
							)
								throw new Error("Preserve all unpublished repository identities");
							const prepared = event.prepared as PreparedBatch;
							return {
								state: {
									...ctx.state,
									drafts: [...ctx.state.drafts.filter((draft) => draft.receipt), ...drafts],
									approved: [],
									epic: prepared.epic,
									epicRevision: prepared.epicRevision,
								},
							};
						})
						.to("prepare_review"),
				),
		)
		.turn(
			flow
				.automatic<SplitParams, SplitState>("publish_tickets")
				.description("Create approved Jira tickets")
				.integrationTools("jira_split_publish")
				.run(async (ctx) => {
					const results = [];
					for (const repositoryKey of ctx.state.approved)
						results.push({
							repositoryKey,
							...asUnknownRecord(
								await ctx.callIntegrationTool("jira_split_publish", { repositoryKey }),
							),
						});
					const pending = publicationState(ctx.state, results).drafts.some(
						(draft) =>
							!draft.receipt &&
							!draft.excluded &&
							(draft.verdict === "applicable" || draft.verdict === "unresolved"),
					);
					return { outcome: pending ? "published" : "finished", params: { results } };
				})
				.outcome("published", (outcome) =>
					recordPublication(outcome)
						.description("Partial ticket publication recorded")
						.to("prepare_review"),
				)
				.outcome("finished", (outcome) =>
					recordPublication(outcome)
						.description("All ticket dispositions recorded")
						.to("complete_split"),
				),
		)
		.turn(
			flow
				.automatic<SplitParams, SplitState>("complete_split")
				.description("Issue split result")
				.run((ctx) => ({
					outcome: "done",
					params: { result: batchMarkdown(ctx.params, ctx.state) },
				}))
				.outcome("done", (outcome) =>
					outcome
						.description("Ticket batch finished")
						.markdown("result", { publish: true })
						.complete(),
				),
		)
		.define();
}
