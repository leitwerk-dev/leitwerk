import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { expect } from "vitest";
import { test } from "../testing/fixture.js";

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
