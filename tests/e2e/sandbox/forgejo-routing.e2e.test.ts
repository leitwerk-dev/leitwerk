import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { expect } from "vitest";
import { control, publish, remote, repo, revised, test } from "./forgejo-fixture.js";

for (const scene of ["forgejo-feedback-no-change", "forgejo-feedback-operator"])
	test(`${scene} routes without publishing an unexplained change`, async ({ f }) => {
		const id = await f.launch(scene),
			pr = await publish(f, id);
		await control(f, "feedback");
		await f.post("/__local/poll");
		if (scene.endsWith("operator")) {
			await f.wait(id, "ci_operator_action");
			await f.action(id, "resume_waiting");
			await f.wait(id, "deliver_change");
		} else {
			await waitForValue(
				() => repo(f).replies?.length,
				(n) => n === 1,
				12000,
			);
			await f.wait(id, "deliver_change");
		}
		expect(remote(f, id).headSha).toBe(pr.head.sha);
	}, 60000);

test("CI ignores stale branch/head and success, repairs three times, then allows operator recovery", async ({
	f,
}) => {
	const id = await f.launch("forgejo-change"),
		pr = await publish(f, id);
	await control(f, "pipeline", { branch: "main", status: "failure" });
	expect(remote(f, id).ciRecoveryCycles).toBe(0);
	await control(f, "pipeline");
	await revised(f, id, pr.head.sha);
	await control(f, "pipeline", { sha: pr.head.sha, status: "failure" });
	expect(remote(f, id).ciRecoveryCycles).toBe(1);
	await control(f, "pipeline"); // deterministic check now passes
	expect(remote(f, id).ciRecoveryCycles).toBe(1);
	for (let n = 2; n <= 3; n++) {
		const head = remote(f, id).headSha;
		await control(f, "pipeline", { status: "failure" });
		await revised(f, id, head);
	}
	await control(f, "pipeline", { status: "failure" });
	await f.wait(id, "ci_operator_action");
	expect(remote(f, id).ciRecoveryCycles).toBe(3);
	await f.action(id, "retry_repair");
	await f.wait(id, "deliver_change");
	expect(repo(f).pulls).toHaveLength(1);
}, 60000);
