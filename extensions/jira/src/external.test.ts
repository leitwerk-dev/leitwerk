import {
	type CapabilityToken,
	type CoreServerSetupDeps,
	coreHostCapabilities,
} from "@leitwerk-dev/process-sdk";
import { createTestServerSetupCapability, createToolCollector } from "@leitwerk-dev/test-support";
import { expect, it, vi } from "vitest";
import type { JiraClientLike, JiraIssue } from "./client.js";
import { setupJiraIntegration } from "./index.js";

it.each([
	"use-leitwerk",
	"use-leitwerk-beta",
])("keeps %s approval on unavailable or repointed sources and correlates bypass to the current plan", async (triggerLabel) => {
	let time = 0;
	let unavailable = true;
	let baseUrl = "https://jira.test/context";
	let armed = {
		id: "bypass_plan",
		instanceId: "process",
		generation: "one",
		resolved: {
			triggerLabel,
			profile: "team",
			baseUrl,
			issueId: "501",
			planRevision: 2,
			mode: "plan_bypass",
		},
	};
	const issue: JiraIssue = {
		id: "501",
		key: "APP-1",
		fields: {
			summary: "Change",
			description: null,
			components: [],
			project: { id: "100", key: "APP", name: "App" },
			labels: [triggerLabel, "leitwerk-skip-plan-decision"],
			status: { statusCategory: { key: "new" } },
		},
	};
	const fire = vi.fn(async () => ({ ok: true }));
	const observe = vi.fn(async () => ({ ok: true }));
	const deps = createTestServerSetupCapability({
		externalSources: { listArmed: () => [armed], fire, observe },
	} as unknown as Partial<CoreServerSetupDeps>);
	const { api } = createToolCollector();
	const client = {
		get baseUrl() {
			return baseUrl;
		},
		async getIssue() {
			if (unavailable) throw new Error("Jira unavailable");
			return issue;
		},
	} as JiraClientLike;
	const poller = setupJiraIntegration(
		{
			...api,
			provide() {},
			get<T>(token: CapabilityToken<T>): T | undefined {
				return token === coreHostCapabilities.serverSetup ? (deps as T) : undefined;
			},
		},
		{ profiles: () => ["team"], client: () => client },
		{ now: () => time },
	);
	if (!poller) throw new Error("Missing Jira poller");
	expect((await poller.poll()).errors).toContain("bypass_plan:Jira unavailable");
	expect(fire).not.toHaveBeenCalled();
	expect(observe).toHaveBeenCalledWith(
		expect.objectContaining({ refreshError: expect.any(String) }),
	);
	unavailable = false;
	baseUrl = "https://jira.test/other";
	time += 30000;
	expect((await poller.poll()).errors.join(" ")).toContain("installation changed");
	expect(fire).not.toHaveBeenCalled();
	baseUrl = armed.resolved.baseUrl;
	armed = { ...armed, generation: "two", resolved: { ...armed.resolved, planRevision: 3 } };
	time += 30000;
	expect((await poller.poll()).errors).toEqual([]);
	expect(fire).toHaveBeenCalledWith(
		expect.objectContaining({
			generation: "two",
			event: { issueId: "501", planRevision: 3 },
		}),
	);
	issue.fields.labels = ["leitwerk-skip-plan-decision"];
	fire.mockClear();
	time += 30000;
	await poller.poll();
	expect(fire).not.toHaveBeenCalled();
});
