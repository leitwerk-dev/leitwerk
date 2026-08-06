import type {
	ProcessInstance,
	ProcessTurnAnnotation,
	ProcessTurnRecord,
} from "@leitwerk-dev/domain";
import type { ProcessRunTurnView } from "@leitwerk-dev/protocol/http-contracts";
import { describe, expect, it } from "vitest";
import { presentProcessInstanceTree } from "./process-instance-tree-presenter.js";
import {
	createTestProcessInstance,
	createTestTurnRecord,
} from "./test-helpers/process-model-fixtures.js";

const process: ProcessInstance = createTestProcessInstance({
	id: "agt_tree",
	processId: "change",
	selectedTurnId: null,
	lifecycleStatus: "completed",
	planRevision: 1,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:05:00.000Z",
});

function record(
	id: string,
	turnId: string,
	startedAt: string,
	options: Partial<ProcessTurnRecord> = {},
): ProcessTurnRecord {
	return createTestTurnRecord({
		id,
		instanceId: process.id,
		turnId,
		resultPiEntryId: `${id}:result`,
		startedAt,
		endedAt: startedAt,
		...options,
	});
}

const details: ProcessRunTurnView[] = [
	{
		turnId: "plan",
		description: "Generate plan",
		pathType: "primary",
		consumedProducts: [],
		publishedProducts: ["plan", "constraints"],
		activePiToolNames: [],
		outcomeActions: [],
	},
	{
		turnId: "implement",
		description: "Implement",
		pathType: "primary",
		consumedProducts: ["plan", "constraints"],
		publishedProducts: [],
		activePiToolNames: [],
		outcomeActions: [],
	},
];

describe("presentProcessInstanceTree", () => {
	it("separates fresh context from product input and labels the action that caused it", () => {
		const plan = record("turn-plan", "plan", "2026-01-01T00:01:00.000Z");
		const decision = record("turn-decision", "plan_decision", "2026-01-01T00:02:00.000Z", {
			turnType: "human",
			resultPiEntryId: null,
		});
		const implement = record("turn-implement", "implement", "2026-01-01T00:03:00.000Z");
		const annotation: ProcessTurnAnnotation = {
			id: "annotation",
			instanceId: process.id,
			annotationType: "acceptance_state",
			annotationKey: null,
			references: [{ kind: "turn_record", turnRecordId: decision.id, role: "subject" }],
			payload: {
				actionLabel: "Approve plan",
				causedSelectedTurnId: "implement",
			},
			createdAt: decision.startedAt,
			updatedAt: decision.startedAt,
		};

		const tree = presentProcessInstanceTree({
			process,
			turnRecords: [plan, decision, implement],
			turnAnnotations: [annotation],
			turnDetails: details,
		});

		expect(tree.nodes.map((node) => node.id)).toEqual([plan.id, implement.id]);
		expect(tree.nodes[1]).toMatchObject({ parentId: null, label: "Implement" });
		expect(tree.edges).toEqual([
			expect.objectContaining({
				sourceNodeId: plan.id,
				targetNodeId: implement.id,
				productLabels: ["Plan", "Constraints"],
				actionLabel: "Approve plan",
			}),
		]);
	});

	it("anchors an action to the explicit product source when it is stronger than chronology", () => {
		const plan = record("plan-source", "plan", "2026-01-01T00:01:00.000Z");
		const sideReview = record("side-review", "review", "2026-01-01T00:02:00.000Z", {
			pathType: "root_branch",
		});
		const decision = record("decision", "plan_decision", "2026-01-01T00:03:00.000Z", {
			turnType: "human",
			resultPiEntryId: null,
		});
		const implement = record("implementation", "implement", "2026-01-01T00:04:00.000Z");
		const tree = presentProcessInstanceTree({
			process,
			turnRecords: [plan, sideReview, decision, implement],
			turnAnnotations: [
				{
					id: "approve",
					instanceId: process.id,
					annotationType: "acceptance_state",
					annotationKey: null,
					references: [{ kind: "turn_record", turnRecordId: decision.id, role: "subject" }],
					payload: {
						actionLabel: "Approve plan",
						sourceTurnRecordId: sideReview.id,
						causedSelectedTurnId: "implement",
						causedSelectedTurnType: "llm",
					},
					createdAt: decision.startedAt,
					updatedAt: decision.startedAt,
				},
			],
			turnDetails: [
				...details,
				{
					turnId: "review",
					description: "Review",
					pathType: "root_branch",
					consumedProducts: [],
					publishedProducts: ["review"],
					activePiToolNames: [],
					outcomeActions: [],
				},
			],
		});

		expect(tree.edges.find((edge) => edge.actionLabel === "Approve plan")).toMatchObject({
			sourceNodeId: plan.id,
			targetNodeId: implement.id,
		});
	});

	it("projects recorded actions as transitions and dead ends without process-specific rules", () => {
		const draft = record("draft", "draft", "2026-01-01T00:01:00.000Z");
		const request = record("request", "decision", "2026-01-01T00:02:00.000Z", {
			turnType: "human",
			resultPiEntryId: null,
		});
		const revision = record("revision", "draft", "2026-01-01T00:03:00.000Z");
		const review = record("review", "review", "2026-01-01T00:04:00.000Z", {
			pathType: "root_branch",
		});
		const dismiss = record("dismiss", "review_decision", "2026-01-01T00:05:00.000Z", {
			turnType: "human",
			resultPiEntryId: null,
		});
		const accept = record("accept", "review_decision", "2026-01-01T00:06:00.000Z", {
			turnType: "human",
			resultPiEntryId: null,
		});
		const acceptedDraft = record("accepted-draft", "draft", "2026-01-01T00:07:00.000Z");
		const annotation = (
			id: string,
			subjectId: string,
			actionLabel: string,
			createdAt: string,
			causedSelectedTurnId: string,
			causedSelectedTurnType: "llm" | "human",
			sourceTurnRecordId?: string,
		): ProcessTurnAnnotation => ({
			id,
			instanceId: process.id,
			annotationType: "acceptance_state",
			annotationKey: null,
			references: [{ kind: "turn_record", turnRecordId: subjectId, role: "subject" }],
			payload: {
				actionLabel,
				causedSelectedTurnId,
				causedSelectedTurnType,
				...(sourceTurnRecordId ? { sourceTurnRecordId } : {}),
			},
			createdAt,
			updatedAt: createdAt,
		});

		const tree = presentProcessInstanceTree({
			process,
			turnRecords: [draft, request, revision, review, dismiss, accept, acceptedDraft],
			turnAnnotations: [
				annotation(
					"request-annotation",
					request.id,
					"Request revision",
					request.startedAt,
					"draft",
					"llm",
					draft.id,
				),
				annotation(
					"dismiss-annotation",
					dismiss.id,
					"Dismiss review",
					dismiss.startedAt,
					"decision",
					"human",
					review.id,
				),
				annotation(
					"accept-annotation",
					accept.id,
					"Accept review",
					accept.startedAt,
					"draft",
					"llm",
					review.id,
				),
			],
		});

		expect(tree.edges.filter((edge) => edge.actionLabel)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceNodeId: draft.id,
					targetNodeId: revision.id,
					actionLabel: "Request revision",
				}),
				expect.objectContaining({
					sourceNodeId: review.id,
					targetNodeId: null,
					actionLabel: "Dismiss review",
				}),
				expect.objectContaining({
					sourceNodeId: review.id,
					targetNodeId: acceptedDraft.id,
					actionLabel: "Accept review",
				}),
			]),
		);
	});

	it("projects automatic follow-up transitions and a successful terminal end", () => {
		const implementation = record("implementation", "implement", "2026-01-01T00:01:00.000Z");
		const mergeDecision = record(
			"merge-decision",
			"implementation_decision",
			"2026-01-01T00:02:00.000Z",
			{
				turnType: "human",
				resultPiEntryId: null,
			},
		);
		const initialMerge = record("merge-1", "commit_and_merge", "2026-01-01T00:03:00.000Z", {
			turnType: "automatic",
			resultPiEntryId: null,
		});
		const commit = record("commit", "commit_worktree", "2026-01-01T00:04:00.000Z");
		const retryMerge = record("merge-2", "commit_and_merge", "2026-01-01T00:05:00.000Z", {
			turnType: "automatic",
			resultPiEntryId: null,
		});
		const resolve = record("resolve", "resolve_merge_conflict", "2026-01-01T00:06:00.000Z");
		const finalMerge = record("merge-3", "commit_and_merge", "2026-01-01T00:07:00.000Z", {
			turnType: "automatic",
			resultPiEntryId: null,
		});
		const tree = presentProcessInstanceTree({
			process,
			turnRecords: [
				implementation,
				mergeDecision,
				initialMerge,
				commit,
				retryMerge,
				resolve,
				finalMerge,
			],
			turnAnnotations: [
				{
					id: "merge-action",
					instanceId: process.id,
					annotationType: "acceptance_state",
					annotationKey: null,
					references: [{ kind: "turn_record", turnRecordId: mergeDecision.id, role: "subject" }],
					payload: {
						actionLabel: "Merge change",
						sourceTurnRecordId: implementation.id,
						causedSelectedTurnId: "commit_and_merge",
						causedSelectedTurnType: "automatic",
					},
					createdAt: mergeDecision.startedAt,
					updatedAt: mergeDecision.startedAt,
				},
			],
		});

		expect(tree.currentLeafId).toBeNull();
		expect(tree.edges.filter((edge) => edge.actionLabel)).toEqual([
			expect.objectContaining({
				sourceNodeId: implementation.id,
				targetNodeId: commit.id,
				actionLabel: "Merge change",
				endState: null,
			}),
			expect.objectContaining({
				sourceNodeId: commit.id,
				targetNodeId: resolve.id,
				actionLabel: "Commit And Merge",
				endState: null,
			}),
			expect.objectContaining({
				sourceNodeId: resolve.id,
				targetNodeId: null,
				actionLabel: "Commit And Merge",
				endState: "completed",
			}),
		]);
	});

	it("uses the actual Pi fork entry for inherited context", () => {
		const first = record("first", "plan", "2026-01-01T00:01:00.000Z");
		const revision = record("revision", "plan", "2026-01-01T00:02:00.000Z", {
			forkPiEntryId: first.resultPiEntryId,
			pathType: "leaf_branch",
		});
		const tree = presentProcessInstanceTree({
			process: { ...process, lifecycleStatus: "waiting" },
			turnRecords: [first, revision],
			turnDetails: details,
			currentPiEntryId: first.resultPiEntryId,
		});

		expect(tree.currentLeafId).toBe(first.id);
		expect(tree.nodes[1]?.parentId).toBe(first.id);
		expect(tree.edges.filter((edge) => edge.hasContext)).toEqual([
			expect.objectContaining({
				sourceNodeId: first.id,
				targetNodeId: revision.id,
			}),
		]);
	});
});
