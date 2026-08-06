import { describe, expect, it } from "vitest";
import type { FutureLaunchSummary, UiLauncherSummary } from "./api.js";
import { buildFutureLaunchDetailSections } from "./future-launch-detail.js";

function createFutureLaunch(overrides: Partial<FutureLaunchSummary> = {}): FutureLaunchSummary {
	return {
		id: "fut_1",
		kind: "launch",
		scheduleKind: "once",
		processId: "mr_polish_process",
		nextRunAt: "2026-01-01T13:05:00.000Z",
		cronExpression: null,
		title: "Polish MR",
		subtitle: "Scheduled start",
		launcherId: "mr-polish",
		launcherLabel: "MR polish",
		launchTitle: "Polish MR",
		launcherInput: {},
		modelConfig: {},
		...overrides,
	};
}

function createLauncher(): UiLauncherSummary {
	return {
		id: "mr-polish",
		processId: "mr_polish_process",
		displayName: "MR Polish",
		label: "MR polish",
		description: "Polish a merge request",
		card: { title: "MR Polish", description: "Polish a merge request" },
		launchConfigSchema: {
			id: "mr-polish-form",
			title: "MR Polish",
			submitLabel: "Launch",
			fields: [
				{ id: "repoPath", label: "Repository", kind: "text" },
				{ id: "baseBranch", label: "Base branch", kind: "text" },
				{ id: "instructions", label: "Instructions", kind: "textarea" },
				{ id: "dryRun", label: "Dry run", kind: "boolean" },
			],
		},
		modelConfigSchema: { availableProfiles: [], llmTurns: [] },
	};
}

describe("buildFutureLaunchDetailSections", () => {
	it("groups scheduled launch fields by operator meaning", () => {
		const sections = buildFutureLaunchDetailSections(
			createFutureLaunch({
				launcherInput: {
					repoPath: "/work/repo",
					baseBranch: "main",
					instructions: "Fix the flaky test.",
					dryRun: true,
				},
				modelConfig: {
					defaultModelProfileId: "claude_fast",
					turnConfigs: { implement: { modelProfileId: "local_qwen" } },
				},
			}),
			createLauncher(),
		);

		expect(sections.map((section) => section.id)).toEqual([
			"schedule",
			"process",
			"projects",
			"branches",
			"instructions",
			"details",
			"runtime",
		]);
		expect(sections.find((section) => section.id === "projects")?.items).toEqual([
			{ label: "Repository", value: "/work/repo" },
		]);
		expect(sections.find((section) => section.id === "details")?.items).toEqual([
			{ label: "Dry run", value: "Yes" },
		]);
	});

	it("omits empty optional field groups", () => {
		const sections = buildFutureLaunchDetailSections(createFutureLaunch(), createLauncher());

		expect(sections.map((section) => section.id)).toEqual(["schedule", "process"]);
	});

	it("describes cron schedules and preserves unknown launcher values", () => {
		const sections = buildFutureLaunchDetailSections(
			createFutureLaunch({
				scheduleKind: "cron",
				cronExpression: "0 9 * * 1-5",
				launcherInput: { customPayload: { issue: "JIRA-123" } },
			}),
			null,
		);

		expect(sections.find((section) => section.id === "schedule")?.items).toContainEqual({
			label: "Recurrence",
			value: "0 9 * * 1-5",
		});
		expect(sections.find((section) => section.id === "details")?.items[0]?.label).toBe(
			"Custom Payload",
		);
		expect(sections.find((section) => section.id === "details")?.items[0]?.value).toContain(
			"JIRA-123",
		);
	});
});
