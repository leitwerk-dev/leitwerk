import type { SettingsSubject } from "@leitwerk-dev/domain";
import {
	type CapabilityToken,
	type CoreServerSetupDeps,
	coreHostCapabilities,
	type ScopedSettingsResolver,
	scopedSettingsCapability,
} from "@leitwerk-dev/process-sdk";
import { createTestServerSetupCapability, createToolCollector } from "@leitwerk-dev/test-support";
import { expect, it, vi } from "vitest";
import type { JiraClientLike } from "./client.js";
import { jiraSubjectIdentity, setupJiraIntegration } from "./index.js";

it.each([
	"watcher",
	"profile",
])("discovers and lists only projects configured by the %s", async (source) => {
	const projects = [
		{ id: "10100", key: "CLD", name: "Cloud" },
		{ id: "10200", key: "OPS", name: "Operations" },
	];
	const client = {
		baseUrl: "https://jira.test",
		listProjects: vi.fn(async () => projects),
		listComponents: vi.fn(async (id: string) => [{ id: `${id}-component`, name: "Service" }]),
	} as unknown as JiraClientLike;
	const providers = new Map<
		string,
		{
			discover: Parameters<ScopedSettingsResolver["registerDiscovery"]>[1];
			options: Parameters<ScopedSettingsResolver["registerDiscovery"]>[2];
		}
	>();
	const settings: ScopedSettingsResolver = {
		resolve() {
			throw new Error("Unused resolver");
		},
		discover(input) {
			return { ...input, id: input.identity } as SettingsSubject;
		},
		registerDiscovery(scope, discover, options) {
			providers.set(scope, { discover, options });
		},
	};
	const deps = createTestServerSetupCapability({
		processWatchers: {
			listBySource: () =>
				source === "watcher" ? [{ config: { profile: "team", projects: ["10100"] } }] : [],
		},
	} as unknown as Partial<CoreServerSetupDeps>);
	const { api } = createToolCollector();
	setupJiraIntegration(
		{
			...api,
			provide() {},
			get<T>(token: CapabilityToken<T>): T | undefined {
				if (token === scopedSettingsCapability) return settings as T;
				if (token === coreHostCapabilities.serverSetup) return deps as T;
				return undefined;
			},
		},
		{ profiles: () => ["team"], client: () => client },
		{
			projects: source === "profile" ? new Map([["team", ["CLD"]]]) : undefined,
		},
	);
	const projectProvider = providers.get("jira.project");
	const componentProvider = providers.get("jira.component");
	if (!projectProvider || !componentProvider) throw new Error("Missing Jira discovery");
	const discovered = await projectProvider.discover();
	expect(discovered.map((subject) => subject.label)).toEqual(["CLD · Cloud"]);
	const components = await componentProvider.discover();
	expect(components.map((subject) => subject.label)).toEqual(["CLD / Service"]);
	expect(client.listComponents).toHaveBeenCalledExactlyOnceWith("10100");
	const parents = projects.map((project) =>
		settings.discover({
			scopeType: "jira.project",
			identity: jiraSubjectIdentity(client.baseUrl, project.id),
			label: `${project.key} · ${project.name}`,
		}),
	);
	expect(projectProvider.options?.includesSubject?.(parents[0], {})).toBe(true);
	expect(projectProvider.options?.includesSubject?.(parents[1], {})).toBe(false);
	const component = settings.discover(components[0]);
	expect(
		componentProvider.options?.includesSubject?.(component, { "jira.project": parents[0] }),
	).toBe(true);
	expect(
		componentProvider.options?.includesSubject?.(component, { "jira.project": parents[1] }),
	).toBe(false);
	expect(
		projectProvider.options?.includesSubject?.(
			{ ...parents[0], identity: jiraSubjectIdentity("https://other-jira.test", "10100") },
			{},
		),
	).toBe(false);
});
