import { emptyCompactTurnSummary } from "@leitwerk-dev/protocol";
import Fastify from "fastify";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getDefaultConfig } from "../config/config-loader.js";
import { createAllRepos } from "../db/repositories.js";
import { createAcceptedWorkerTurn } from "../test-helpers/accepted-turn-start.js";
import {
	createOwnedInMemoryDatabase,
	createOwnedTestDeps,
} from "../test-helpers/owned-test-deps.js";
import { createDefaultTestProcessGraphRegistry } from "../test-helpers/process-fixtures.js";
import {
	aggregateDashboardCosts,
	buildDashboard,
	type DashboardRouteDeps,
	registerDashboardRoutes,
} from "./dashboard.js";

describe("dashboard", () => {
	it("distinguishes absent and zero costs and sorts model identities deterministically", () => {
		expect(aggregateDashboardCosts([]).totalUsd).toBe(0);
		expect(
			aggregateDashboardCosts([{ providerId: null, modelId: null, costUsd: null }]),
		).toMatchObject({ totalUsd: null, isPartial: true, missingCostTurnCount: 1 });
		expect(aggregateDashboardCosts([{ providerId: "p", modelId: "m", costUsd: 0 }])).toMatchObject({
			totalUsd: 0,
			pricedTurnCount: 1,
			isPartial: false,
		});
		expect(
			aggregateDashboardCosts([
				{ providerId: "z", modelId: "m", costUsd: 1 },
				{ providerId: "a", modelId: "m", costUsd: 1 },
				{ providerId: "a", modelId: "m", costUsd: null },
			]),
		).toMatchObject({
			totalUsd: 2,
			totalLlmTurnCount: 3,
			pricedTurnCount: 2,
			byModel: [
				{ providerId: "a", turnCount: 1 },
				{ providerId: "z", turnCount: 1 },
			],
		});
	});

	it("projects historical identities across profiles and all accepted branch records without content reads", () => {
		const db = createOwnedInMemoryDatabase();
		const repos = createAllRepos(db);
		const instance = repos.processes.create({ processId: "retained" });
		for (const [index, status] of (["succeeded", "failed", "running"] as const).entries()) {
			const record = createAcceptedWorkerTurn(
				{ deps: repos },
				{
					id: `turn-${index}`,
					instanceId: instance.id,
					turnId: "run",
					turnType: "llm",
					status,
					pathType: index === 2 ? "root_branch" : "primary",
					attemptNumber: index + 1,
					modelProfileId: `profile-${index}`,
				},
				{
					model: {
						profileId: `profile-${index}`,
						providerId: "historic-provider",
						modelId: "historic-model",
						thinkingLevel: "off",
					},
					current: index === 2,
				},
			);
			if (index !== 2) {
				repos.turnSummaries.put(instance.id, record.id, {
					...emptyCompactTurnSummary(),
					assistant: { text: "secret", thinking: "secret", lastUpdatedAt: null },
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
					},
				});
			}
		}
		db.$client
			.prepare("UPDATE turn_start_records SET start_kind = 'retry' WHERE id = ?")
			.run("tsr_turn-2");
		const rows = repos.turnSummaries.listDashboardCosts();
		// Profile ids can change or disappear; grouping depends only on accepted snapshots.
		db.$client.prepare("UPDATE turn_records SET model_profile_id = 'removed-profile'").run();
		expect(repos.turnSummaries.listDashboardCosts()).toEqual(rows);
		expect(rows).toHaveLength(3);
		expect(rows.every((row) => Object.keys(row).length === 3)).toBe(true);
		expect(aggregateDashboardCosts(rows)).toMatchObject({
			totalUsd: 2,
			pricedTurnCount: 2,
			missingCostTurnCount: 1,
			byModel: [
				{ providerId: "historic-provider", modelId: "historic-model", turnCount: 2, costUsd: 2 },
			],
		});
	});

	it("retains unattributed costs when historical identity is unavailable", () => {
		const db = createOwnedInMemoryDatabase();
		const repos = createAllRepos(db);
		const instance = repos.processes.create({ processId: "legacy" });
		createAcceptedWorkerTurn(
			{ deps: repos },
			{
				id: "legacy-turn",
				instanceId: instance.id,
				turnId: "run",
				turnType: "llm",
				status: "succeeded",
			},
		);
		db.$client
			.prepare(
				"UPDATE turn_start_records SET state_json = json_remove(state_json, '$.start.model') WHERE id = ?",
			)
			.run("tsr_legacy-turn");
		const summary = emptyCompactTurnSummary();
		summary.usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		repos.turnSummaries.put(instance.id, "legacy-turn", summary);
		expect(aggregateDashboardCosts(repos.turnSummaries.listDashboardCosts())).toMatchObject({
			totalUsd: 0,
			pricedTurnCount: 1,
			byModel: [{ providerId: null, modelId: null, costUsd: 0, turnCount: 1 }],
		});
	});

	it("counts the complete retained installation and exposes the HTTP contract", async () => {
		const repos = createOwnedTestDeps();
		for (let i = 0; i < 125; i++)
			repos.processes.create({
				processId: "retained",
				lifecycleStatus: i < 20 ? "completed" : i < 50 ? "discovered" : "active",
			});
		const deps: DashboardRouteDeps = {
			...repos,
			config: getDefaultConfig(),
			processGraphs: createDefaultTestProcessGraphRegistry(),
			modelStatusCache: {
				snapshot: repos.getModelAvailabilitySnapshot,
				refresh: async () => repos.getModelAvailabilitySnapshot(),
				get: () => null,
			},
			scopedSettingsService: undefined,
			skillCatalog: undefined,
		};
		const events = vi.spyOn(repos.events, "listByTurnRecord");
		const sessions = vi.spyOn(repos.turnSummaries, "getSession");
		const body = buildDashboard(deps);
		expect(body.definitions.items[0].id).toBe("mr_polish_process");
		expect(body.processes.total).toBe(125);
		expect(body.processes.byDefinition).toEqual([
			{ processId: "retained", name: "retained", count: 125 },
		]);
		expect(body.processes.byStatus).toContainEqual({ status: "running", count: 105 });
		expect(events).not.toHaveBeenCalled();
		expect(sessions).not.toHaveBeenCalled();
		const app = Fastify();
		onTestFinished(() => app.close());
		registerDashboardRoutes(app, deps);
		const response = await app.inject({ method: "GET", url: "/api/dashboard" });
		expect(response.statusCode).toBe(200);
		expect(response.json().processes.total).toBe(125);
	});
});
