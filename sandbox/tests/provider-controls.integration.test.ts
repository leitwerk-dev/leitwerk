import { expect } from "vitest";
import { control, test } from "../testing/forgejo-fixture.js";

test("provider controls reject escaping repositories, mismatched IDs and nonlocal requests", async ({
	f,
}) => {
	for (const payload of [
		{ operation: "create-issue", repository: "../outside", requestId: "outside-repository" },
		{
			operation: "merge",
			repository: "examples/garden",
			number: 9999,
			requestId: "unknown-pull-request",
		},
		{ operation: "set-lifecycle", requestId: "forbidden-lifecycle" },
	]) {
		expect(
			(await f.context.app.inject({ method: "POST", url: "/__local/providers/control", payload }))
				.statusCode,
		).toBe(400);
	}
	expect(
		(
			await f.context.app.inject({
				method: "POST",
				url: "/__local/providers/control",
				headers: { origin: "https://outside.example" },
				payload: { operation: "create-issue" },
			})
		).statusCode,
	).toBe(403);
	expect(f.context.deps.processes.listAll()).toHaveLength(0);
	// Receipt pages are a sandbox control surface, not ticket-creation behavior.
	const created = await control(f, "create-issue");
	await f.restart();
	const receipt = await f.context.app.inject(new URL(created.result.html_url).pathname);
	expect(receipt.statusCode).toBe(200);
	expect(receipt.body).toContain(created.result.title);
}, 60000);
