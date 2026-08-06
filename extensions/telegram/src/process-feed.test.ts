import type { ProcessTurnRecord } from "@leitwerk-dev/domain";
import { formatPathTypeLabel } from "@leitwerk-dev/domain";
import { createTestProcessInstance } from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it } from "vitest";
import {
	buildActionSubmittedMessage,
	buildActionsPromptMessage,
	buildProcessCreatedMessage,
	buildStatusMessage,
	buildTurnOutcomeMessage,
	buildTurnStartedMessage,
} from "./process-feed.js";

function createTestTurnRecord(overrides?: Partial<ProcessTurnRecord>): ProcessTurnRecord {
	const id = overrides?.id ?? "tr_1";
	const turnType = overrides?.turnType ?? "llm";
	const workerOwned = turnType === "llm" || turnType === "automatic";
	return {
		id,
		instanceId: overrides?.instanceId ?? "inst_1",
		turnId: overrides?.turnId ?? "test_turn",
		turnType,
		status: overrides?.status ?? "running",
		attemptNumber: overrides?.attemptNumber ?? 1,
		parentTurnRecordId: overrides?.parentTurnRecordId ?? null,
		pathType: overrides?.pathType ?? "primary",
		forkPiEntryId: overrides?.forkPiEntryId ?? null,
		turnStartRecordId: overrides?.turnStartRecordId ?? (workerOwned ? `tsr_${id}` : null),
		acceptedWorkerLeaseId: overrides?.acceptedWorkerLeaseId ?? (workerOwned ? `wls_${id}` : null),
		resultPiEntryId: overrides?.resultPiEntryId ?? null,
		modelProfileId: overrides?.modelProfileId ?? null,
		turnResultMarkdown: overrides?.turnResultMarkdown ?? null,
		errorSummary: overrides?.errorSummary ?? null,
		errorClass: overrides?.errorClass ?? null,
		startedAt: overrides?.startedAt ?? new Date().toISOString(),
		endedAt: overrides?.endedAt ?? null,
	};
}

describe("Telegram process feed builders", () => {
	it("escapes process-created links as HTML attributes", () => {
		const process = createTestProcessInstance({ id: "agt_123", title: "Process" });
		const message = buildProcessCreatedMessage({
			process,
			serverBaseUrl: 'https://leitwerk.example/a"b',
		});

		expect(message).toContain('href="https://leitwerk.example/a&quot;b/processes/agt_123"');
	});

	it("includes escaped action labels in prompts and status", () => {
		const process = createTestProcessInstance({
			title: "Primary <control>",
			lifecycleStatus: "waiting",
			selectedTurnId: "control_panel",
		});
		const actions = [{ id: "tail_logs", label: "Tail <logs>" }];

		const prompt = buildActionsPromptMessage({
			process,
			actions,
			recoveryActions: ["Retry"],
			currentTurnPathType: "primary",
		});
		const status = buildStatusMessage({
			process,
			actions,
			currentTurnPathType: "primary",
		});

		expect(prompt).toContain("Primary &lt;control&gt;");
		expect(prompt).toContain("Tail &lt;logs&gt;");
		expect(prompt).toContain("Retry");
		expect(status).toContain("Tail &lt;logs&gt;");
		expect(prompt).toContain(formatPathTypeLabel("primary"));
		expect(status).toContain(formatPathTypeLabel("primary"));
	});

	it("summarizes submitted action input without leaking raw HTML", () => {
		const message = buildActionSubmittedMessage({
			action: {
				id: "tail_logs",
				label: "Tail <logs>",
				form: {
					id: "tail",
					title: "Tail",
					fields: [{ id: "tailLines", label: "Lines <count>", kind: "number" }],
				},
				preview: { kind: "fixed_turn", turnId: "run_operation" },
			},
			values: { tailLines: 50, ignored: "" },
		});

		expect(message).toContain("Tail &lt;logs&gt;");
		expect(message).toContain("Lines &lt;count&gt;");
		expect(message).toContain("50");
		expect(message).toContain("run_operation");
		expect(message).not.toContain("Tail <logs>");
	});

	it("truncates very long submitted action field values", () => {
		const value = `START-${"x".repeat(800)}-END`;
		const message = buildActionSubmittedMessage({
			action: {
				id: "request_changes",
				label: "Request changes",
				form: {
					id: "request_changes",
					title: "Request changes",
					fields: [{ id: "message", label: "Message", kind: "textarea" }],
				},
			},
			values: { message: value },
		});

		expect(message).toContain("START-");
		expect(message).toContain("…");
		expect(message).not.toContain("-END");
	});

	it("renders turn started without model when no modelLabel supplied", () => {
		const turnRecord = createTestTurnRecord({ turnId: "run_operation" });
		const message = buildTurnStartedMessage(turnRecord);

		expect(message).toBe(`▶️ <b>Started</b>: run_operation — ${formatPathTypeLabel("primary")}`);
	});

	it("renders turn started with human-readable description when supplied", () => {
		const turnRecord = createTestTurnRecord({ turnId: "run_operation" });
		const message = buildTurnStartedMessage(turnRecord, {
			turnDescription: "Run operation",
		});

		expect(message).toContain("▶️ <b>Started</b>: Run operation");
		expect(message).toContain(formatPathTypeLabel("primary"));
	});

	it("renders turn started with model when modelLabel supplied", () => {
		const turnRecord = createTestTurnRecord({ turnId: "implement_feature" });
		const message = buildTurnStartedMessage(turnRecord, {
			modelLabel: "deepseek-v4-pro — deepseek/deepseek-v4-pro",
		});

		expect(message).toContain("▶️ <b>Started</b>: implement_feature");
		expect(message).toContain(formatPathTypeLabel("primary"));
		expect(message).toContain(" (model: deepseek-v4-pro");
	});

	it("escapes HTML in modelLabel for turn started", () => {
		const turnRecord = createTestTurnRecord({ turnId: "run_operation" });
		const message = buildTurnStartedMessage(turnRecord, {
			modelLabel: "model <fast> & cheap",
		});

		expect(message).toContain("model &lt;fast&gt; &amp; cheap");
		expect(message).toContain(formatPathTypeLabel("primary"));
	});

	it.each([
		"root_branch",
		"leaf_branch",
	] as const)("includes path label for %s turns", (pathType) => {
		const turnRecord = createTestTurnRecord({ turnId: `${pathType}_turn`, pathType });
		const message = buildTurnStartedMessage(turnRecord);
		expect(message).toContain(formatPathTypeLabel(pathType));
	});

	it("renders turn outcome markdown for Telegram", () => {
		const message = buildTurnOutcomeMessage({
			turnId: "run_operation",
			outcome: "operation_finished",
			markdown: "## Logs\n\nLOG_TOKEN & value",
		});

		expect(message).toContain("run_operation.operation_finished");
		expect(message).toContain("LOG_TOKEN");
		expect(message).toContain("&amp;");
	});

	it("includes path type label in turn outcomes when supplied", () => {
		const message = buildTurnOutcomeMessage({
			turnId: "run_operation",
			outcome: "operation_finished",
			markdown: "result",
			pathType: "root_branch",
		});

		expect(message).toContain(formatPathTypeLabel("root_branch"));
	});

	it("renders status with current turn description and path type", () => {
		const process = createTestProcessInstance({
			lifecycleStatus: "active",
			selectedTurnId: "implement",
		});
		const message = buildStatusMessage({
			process,
			currentTurnDescription: "Implement changes",
			currentTurnPathType: "leaf_branch",
		});

		expect(message).toContain("Implement changes");
		expect(message).toContain(formatPathTypeLabel("leaf_branch"));
		expect(message).not.toContain("implement");
	});

	it("formats fallback selectedTurnId into a human-readable label", () => {
		const process = createTestProcessInstance({
			lifecycleStatus: "active",
			selectedTurnId: "generate_plan",
		});
		const message = buildStatusMessage({ process });

		expect(message).toContain("Generate Plan");
		expect(message).not.toContain("generate_plan");
	});
});
