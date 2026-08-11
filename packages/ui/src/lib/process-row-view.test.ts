import type { ProcessOverviewItem } from "@leitwerk-dev/protocol";
import { describe, expect, it } from "vitest";
import { buildProcessRowView, sortProcessRowViews } from "./process-row-view.js";

function overview(overrides: Partial<ProcessOverviewItem> = {}): ProcessOverviewItem {
	return {
		instanceId: "agt_1",
		processId: "ticket_issue_process",
		processDisplayName: "Poem Creator",
		processTitle: null,
		title: "PROJ-1",
		subtitle: "ticket_issue_process · 0 components",
		initialPromptPreview: null,
		selectedTurnId: "generate_plan",
		lifecycleStatus: "active",
		statusCategory: "active",
		projectCount: 0,
		externalId: "PROJ-1",
		externalLinkCount: 0,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		closedAt: null,
		...overrides,
	};
}

function row(overrides: Partial<ProcessOverviewItem> = {}) {
	return buildProcessRowView(overview(overrides));
}

function terminalRow(id: string, title: string, closedAt: string | null) {
	return row({
		instanceId: id,
		title,
		selectedTurnId: null,
		lifecycleStatus: "completed",
		statusCategory: "terminal",
		closedAt,
	});
}

describe("buildProcessRowView", () => {
	it("keeps the current turn label and provided server projection", () => {
		const view = row({ initialPromptPreview: "Build the archive page" });

		expect(view.processDisplayName).toBe("Poem Creator");
		expect(view.turnLabel).toBe("Generate Plan");
		expect(view.statusLine).toBe("Running · Generate Plan");
		expect(view.initialPrompt).toBe("Build the archive page");
		expect(view.closedAt).toBeNull();
	});

	it("formats the process id when no display name is available", () => {
		expect(row({ processId: "poem_creator", processDisplayName: null }).processDisplayName).toBe(
			"Poem Creator",
		);
	});

	it("projects terminal closure and sorts terminal rows by closure date", () => {
		const sortedTitles = sortProcessRowViews([
			terminalRow("agt_old", "ZZZ older", "2026-01-01T00:00:00Z"),
			terminalRow("agt_new", "AAA newest", "2026-01-03T00:00:00Z"),
			terminalRow("agt_same_b", "Beta same date", "2026-01-02T00:00:00Z"),
			terminalRow("agt_same_a", "Alpha same date", "2026-01-02T00:00:00Z"),
			terminalRow("agt_invalid", "AAA unknown closure", "not-a-date"),
		]).map((candidate) => candidate.title);

		expect(sortedTitles).toEqual([
			"AAA newest",
			"Alpha same date",
			"Beta same date",
			"ZZZ older",
			"AAA unknown closure",
		]);
	});
});
