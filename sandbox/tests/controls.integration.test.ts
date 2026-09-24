import { type SandboxCompositionFactory, SandboxControlError } from "@leitwerk-dev/dev-sandbox";
import { startSandboxHarness } from "@leitwerk-dev/dev-sandbox/testing";
import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { expect, test as plainTest } from "vitest";
import composition from "../composition.js";
import { test } from "../testing/fixture.js";

plainTest(
	"scenarios can admit through an existing launcher with prepared input",
	async ({ onTestFinished }) => {
		const prepared: string[] = [];
		const factory: SandboxCompositionFactory = (input) => {
			const base = composition(input);
			return {
				...base,
				scenarios: [
					...base.scenarios,
					{
						name: "relay",
						description: "Admit through the question scenario's launcher.",
						launcherId: "sandbox.question",
						async prepareLaunch(requestId, body) {
							if (body.accept !== true) throw new SandboxControlError(422, "Not accepted");
							prepared.push(requestId);
							return {};
						},
					},
				],
			};
		};
		const sandbox = await startSandboxHarness(factory);
		onTestFinished(() => sandbox.stop());
		const rejected = await sandbox.admitScenario("relay", { requestId: "relay-request" });
		expect(rejected).toEqual({ statusCode: 422, body: { error: "Not accepted" } });
		const invalid = await sandbox.context.app.inject({
			method: "POST",
			url: "/__local/scenarios",
			payload: { name: "relay", requestId: "relay-request", input: ["accept"] },
		});
		expect(invalid.statusCode).toBe(400);
		const request = { requestId: "relay-request", input: { accept: true } };
		const first = await sandbox.admitScenario("relay", request);
		const second = await sandbox.admitScenario("relay", request);
		expect(first.statusCode).toBe(202);
		expect(second.body.launchRunId).toBe(first.body.launchRunId);
		expect(prepared).toEqual(["relay-request", "relay-request"]);
		const processes = await waitForValue(
			() => sandbox.context.deps.processes.listAll(),
			(items) => items.length === 1,
			12000,
		);
		expect(processes?.[0]?.externalId).toMatch(/^sandbox:question:/);
	},
	30000,
);

test("controls use configured URLs, reject cross-origin writes and deduplicate launches", async ({
	f,
}) => {
	const state = (await f.context.app.inject("/__local/state")).json();
	expect(state.uiUrl).toBe("http://127.0.0.1:19173");
	expect(state.scenariosAvailable).toHaveLength(9);
	const payload = { name: "ticket", requestId: "repeat-launch-request" };
	const denied = await f.context.app.inject({
		method: "POST",
		url: "/__local/scenarios",
		headers: { origin: "https://example.test" },
		payload,
	});
	expect(denied.statusCode).toBe(403);
	const request = { method: "POST" as const, url: "/__local/scenarios", payload };
	const first = await f.context.app.inject(request);
	const second = await f.context.app.inject(request);
	expect(first.statusCode).toBe(202);
	expect(second.json().launchRunId).toBe(first.json().launchRunId);
	await waitForValue(
		() => f.context.deps.processes.listAll(),
		(p) => p.length === 1,
		12000,
	);
}, 30000);
