import { readFileSync } from "node:fs";
import path from "node:path";
import { LocalForgejoAdapter } from "@leitwerk-dev/forgejo/testing";
import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { LocalWoodpeckerAdapter } from "@leitwerk-dev/woodpecker/testing";
import { expect } from "vitest";
import { providerControls } from "../../../sandbox/provider-controls.js";
import {
	control,
	deliveryKinds,
	publish,
	remote,
	repo,
	revised,
	source,
	subscriptions,
	test,
} from "./forgejo-fixture.js";

// These fixtures use the real file-backed database, provider files, Git and Pi sessions.
// Only legacy field shapes are synthesized; provider controls drive every transition.
for (const waitingFor of ["feedback", "ci", "conflict", "operator", "terminal"] as const) {
	test(`retained ${waitingFor} delivery reopens with legacy metadata and original subscription profiles`, async ({
		f,
	}) => {
		const issueOrigin = ["feedback", "conflict", "terminal"].includes(waitingFor);
		const id = issueOrigin
			? (await source(f)).id
			: await f.launch(waitingFor === "operator" ? "forgejo-ci-operator" : "forgejo-change");
		const pr = await publish(f, id);
		if (waitingFor === "operator") {
			await control(f, "pipeline", { status: "failure" });
			await f.wait(id, "ci_operator_action");
		} else {
			// The selected turn becomes visible before subscription registration finishes.
			// Take the retained snapshot only after all delivery sources are armed.
			await waitForValue(
				() => subscriptions(f, id),
				(armings) => deliveryKinds.every((kind) => armings.some((a) => a.kind === kind)),
				12000,
			);
		}
		if (waitingFor !== "operator") {
			// Waiting state is persisted before asynchronous subscription reconciliation finishes.
			await expect
				.poll(() => subscriptions(f, id).map((a) => a.kind), { timeout: 12000 })
				.toEqual(
					expect.arrayContaining([
						FORGEJO_PR_FEEDBACK_KIND,
						FORGEJO_PR_CONFLICT_KIND,
						FORGEJO_PR_TERMINAL_KIND,
						WOODPECKER_PIPELINE_KIND,
					]),
				);
		}
		const deps = f.context.deps;
		const process = deps.processes.getById(id);
		if (!process) throw new Error("Missing retained delivery");
		const params = JSON.parse(process.paramsJson ?? "{}");
		if (issueOrigin) delete params.origin;
		deps.processes.update(id, { paramsJson: JSON.stringify(params) });
		const project = deps.projects.listByInstance(id)[0];
		const metadata = { ...project.metadata };
		delete metadata.woodpecker;
		metadata.forgejo = {
			owner: params.owner,
			repo: params.repo,
			...(issueOrigin ? { issueNumber: params.issueNumber } : {}),
		};
		deps.projects.update(project.id, { metadata });
		const armings = subscriptions(f, id);
		const turns = deps.turnRecords.listByInstance(id);
		const writes = deps.externalWrites.listByInstance(id);
		const plan = turns.find((t) => t.turnId === "generate_plan");
		if (!plan) throw new Error("No retained planning session");
		const reasoningUrl = `/api/processes/${id}/turn-records/${plan.id}/reasoning`;
		const reasoning = (await f.context.app.inject(reasoningUrl)).json().reasoning;
		expect(writes.some((w) => w.writeType === "forgejo.ensure_pr")).toBe(true);
		// A configuration reload affects future launches; existing params remain authoritative.
		f.config.extensions["forgejo-repo-change"] = {
			profile_bindings: {
				local: { woodpecker_profile: "future-ci", ssh_credential_ref: "future-ssh" },
			},
		};
		await f.restart();
		expect(f.context.deps.processes.getById(id)).toMatchObject({
			id,
			paramsJson: JSON.stringify(params),
			stateJson: process.stateJson,
			selectedTurnId: process.selectedTurnId,
		});
		expect(f.context.deps.projects.listByInstance(id)[0]).toMatchObject({
			id: project.id,
			metadata,
		});
		expect(f.context.deps.turnRecords.listByInstance(id)).toEqual(turns);
		expect(f.context.deps.externalWrites.listByInstance(id)).toEqual(writes);
		expect(subscriptions(f, id)).toEqual(armings);
		expect((await f.context.app.inject(reasoningUrl)).json().reasoning).toEqual(reasoning);
		if (waitingFor === "operator") {
			await f.action(id, "resume_waiting");
			await f.wait(id, "deliver_change");
		} else if (waitingFor === "feedback") {
			await control(f, "feedback");
			await f.post("/__local/poll");
			await revised(f, id, pr.head.sha);
		} else if (waitingFor === "ci") {
			await control(f, "pipeline", { status: "failure" });
			await revised(f, id, pr.head.sha);
		} else if (waitingFor === "conflict") {
			await control(f, "conflict");
			await revised(f, id, pr.head.sha);
			expect(
				readFileSync(
					path.join(
						f.config.storage.process_workspaces_dir,
						id,
						"repo",
						".git",
						"leitwerk-rebase.json",
					),
					"utf8",
				),
			).toContain(pr.head.sha);
		}
		if (waitingFor === "terminal") {
			// The remote merge occurs while this server is down, before subscription rearming.
			await f.restart(async () => {
				const options = { root: f.root, baseUrl: f.input.urls.backend };
				const controls = providerControls(
					new LocalForgejoAdapter(options),
					new LocalWoodpeckerAdapter(options),
					async () => [],
				);
				await controls.run({
					operation: "merge",
					repository: "examples/garden",
					number: pr.number,
					requestId: "offline-terminal-merge",
				});
			});
			await f.post("/__local/poll");
		} else await control(f, "merge");
		await f.wait(id, null, "completed");
		expect(repo(f).pulls).toHaveLength(1);
		const completedProvider = repo(f);
		await f.restart();
		await f.post("/__local/poll");
		expect(repo(f).comments).toEqual(completedProvider.comments);
		expect(repo(f).replies).toEqual(completedProvider.replies);
		expect(remote(f, id).headSha).toBeTruthy();
		expect(subscriptions(f, id)).toEqual([]);
	}, 60000);
}
