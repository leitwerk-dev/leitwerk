import { readFileSync } from "node:fs";
import path from "node:path";
import {
	FORGEJO_ISSUE_CANCELLED_KIND,
	FORGEJO_PR_CONFLICT_KIND,
	FORGEJO_PR_FEEDBACK_KIND,
	FORGEJO_PR_TERMINAL_KIND,
} from "@leitwerk-dev/forgejo";
import type { LocalForgejoState } from "@leitwerk-dev/forgejo/testing";
import type { CoreServerSetupDeps } from "@leitwerk-dev/process-sdk";
import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { WOODPECKER_PIPELINE_KIND } from "@leitwerk-dev/woodpecker";
import type { LocalWoodpeckerState } from "@leitwerk-dev/woodpecker/testing";
import providerComposition from "../provider-composition.js";
import { test as baseTest, type Fixture, fixture } from "./fixture.js";

export const test = baseTest.extend<{ f: Fixture }>({
	f: async ({ onTestFinished }, use) => use(await fixture(onTestFinished, providerComposition)),
});

export const providers = (f: Fixture) => ({
	forgejo: JSON.parse(readFileSync(path.join(f.root, "forgejo.json"), "utf8")) as LocalForgejoState,
	ci: JSON.parse(
		readFileSync(path.join(f.root, "woodpecker.json"), "utf8"),
	) as LocalWoodpeckerState,
});
export const repo = (f: Fixture) => providers(f).forgejo.repositories[0];
export const remote = (f: Fixture, id: string) =>
	JSON.parse(f.context.deps.processes.getById(id)?.stateJson ?? "{}").extensionState
		.forgejoRepoChange;
export const deliveryKinds = [
	FORGEJO_PR_CONFLICT_KIND,
	FORGEJO_PR_FEEDBACK_KIND,
	FORGEJO_PR_TERMINAL_KIND,
	WOODPECKER_PIPELINE_KIND,
];
export function subscriptions(f: Fixture, id: string) {
	const service = f.context.deps.externalSourceService as
		| CoreServerSetupDeps["externalSources"]
		| undefined;
	if (!service) throw new Error("Missing external source service");
	return [...deliveryKinds, FORGEJO_ISSUE_CANCELLED_KIND].flatMap((kind) =>
		service
			.listArmed(kind)
			.filter((a) => a.instanceId === id)
			.map((a) => ({ kind, id: a.id, resolved: a.resolved })),
	);
}
let sequence = 0;
export async function control(f: Fixture, operation: string, input: Record<string, unknown> = {}) {
	return (
		await f.post("/__local/providers/control", {
			operation,
			repository: "examples/garden",
			number: repo(f).pulls[0]?.number,
			requestId: `workflow-control-${++sequence}`,
			...input,
		})
	).json();
}
export async function publish(f: Fixture, id: string) {
	await f.wait(id, "plan_decision");
	await f.action(id, "approve_plan");
	await f.wait(id, "implementation_decision");
	await f.action(id, "finalize_change");
	await f.wait(id, "deliver_change");
	// Lifecycle persistence precedes asynchronous external-source arming.
	await waitForValue(
		() => subscriptions(f, id).map((a) => a.kind),
		(kinds) => deliveryKinds.every((kind) => kinds.includes(kind)),
		12000,
	);
	const pr = repo(f).pulls.find(
		(p) =>
			p.head.ref ===
			JSON.parse(f.context.deps.processes.getById(id)?.paramsJson ?? "{}").workBranch,
	);
	if (!pr) throw new Error("No pull request");
	return pr;
}
export async function source(f: Fixture) {
	const response = await control(f, "create-issue");
	const issue = response.result;
	const p = await waitForValue(
		() =>
			f.context.deps.processes
				.listAll()
				.find((p) => p.externalId === `forgejo:examples/garden#${issue.number}`),
		Boolean,
		12000,
	);
	if (!p) throw new Error("Watcher did not discover source");
	return { id: p.id, issue };
}
export async function revised(f: Fixture, id: string, head: string) {
	await waitForValue(
		() => remote(f, id).headSha,
		(value) => value !== head,
		12000,
	);
	await f.wait(id, "deliver_change");
}
