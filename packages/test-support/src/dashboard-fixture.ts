import type { DashboardResponseBody } from "@leitwerk-dev/protocol/http-contracts";

/** Representative server-ordered dashboard data, fresh for each test. @internal */
export function createDashboardFixture(): DashboardResponseBody {
	return {
		generatedAt: "2026-10-14T10:30:00.000Z",
		definitions: {
			total: 4,
			items: [
				{ id: "smoke", name: "Kubernetes Smoke" },
				{ id: "poem_creator_process", name: "Poem Creator" },
				{ id: "repo_change", name: "Repository Change" },
				{ id: "single_prompt_process", name: "Single Prompt" },
			],
		},
		watchers: {
			total: 4,
			enabled: 3,
			items: [
				{ id: "paused", name: "Paused trigger", enabled: false },
				{ id: "poem", name: "Poem file", enabled: true },
				{ id: "repo", name: "Repository issues", enabled: true },
				{ id: "schedule", name: "Scheduled checks", enabled: true },
			],
		},
		skills: { total: 9, installed: 4, bundled: 5 },
		processes: {
			total: 27,
			byStatus: [
				{ status: "running", count: 3 },
				{ status: "waiting", count: 5 },
				{ status: "error", count: 2 },
				{ status: "completed", count: 16 },
				{ status: "aborted", count: 1 },
			],
			byDefinition: [
				{ processId: "single_prompt_process", name: "Single Prompt", count: 14 },
				{ processId: "poem_creator_process", name: "Poem Creator", count: 8 },
				{ processId: "repo_change", name: "Repository Change", count: 5 },
			],
		},
		costs: {
			totalUsd: 8.4,
			totalLlmTurnCount: 65,
			pricedTurnCount: 60,
			missingCostTurnCount: 5,
			isPartial: true,
			byModel: [
				"gpt-6.1",
				"gpt-6",
				"gpt-6-mini",
				"claude-sonnet",
				"claude-haiku",
				"historical-model",
			].map((modelId, index) => ({
				providerId: index < 3 ? "openai" : "anthropic",
				modelId,
				costUsd: (6 - index) * 0.4,
				turnCount: 10,
			})),
		},
		configuration: {
			issues: [
				{
					id: "credential",
					code: "missing_credential",
					severity: "error",
					message: "The review model profile needs a provider credential.",
					sources: [{ label: "Review model", href: "/settings" }],
				},
				{
					id: "default",
					code: "missing_default",
					severity: "warning",
					message: "Repository Change has no default model profile.",
					sources: [{ label: "Repository Change", href: "/settings" }],
				},
				{
					id: "unavailable",
					code: "unavailable_model",
					severity: "error",
					message: "A configured model is unavailable from its provider.",
					sources: [{ label: "Model catalog", href: "/settings" }],
				},
				{
					id: "override",
					code: "invalid_override",
					severity: "warning",
					message: "A turn override references a removed model profile.",
					sources: [{ label: "Turn settings", href: "/settings" }],
				},
			],
		},
	};
}
