import type { Actor } from "@leitwerk-dev/domain";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { expect, it } from "vitest";
import { createAppContext } from "../app.js";
import { createAllRepos } from "../db/repositories.js";
import { createFixtureHumanTurn, createFixtureProcess } from "../test-helpers/process-fixtures.js";
import { createAuthService } from "./auth-service.js";
import { testAuthConfig } from "./auth-test-helpers.js";

it("preserves the token owner's durable attribution on accepted application mutations after revocation", async () => {
	const config = testAuthConfig();
	const process = createFixtureProcess({
		id: "token_application_test",
		entry: "review",
		turns: { review: createFixtureHumanTurn() },
	});
	const ctx = await createAppContext({
		logger: false,
		config,
		extensionCatalog: buildExtensionCatalogFromModules([
			{
				manifest: { id: "token-application-test", version: "1.0.0" },
				setupCatalog(api) {
					api.registerProcess(process);
				},
			},
		]),
	});
	try {
		const repos = createAllRepos(ctx.db);
		const auth = createAuthService({ config, repos });
		const actor: Actor = { id: "identity:alice", provider: "identity", kind: "user" };
		const owner = auth.apiTokens.ownerForActor(actor);
		const { secret, token } = auth.apiTokens.create(owner, "application", null);
		const headers = { authorization: `Bearer ${secret}` };
		const instance = repos.processes.create({
			processId: process.id,
			selectedTurnId: "review",
			lifecycleStatus: "active",
		});
		const response = await ctx.app.inject({
			method: "POST",
			url: `/api/processes/${instance.id}/steer`,
			headers,
			payload: { message: "Please review the implementation." },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().input.actor).toEqual(actor);
		expect(repos.inputs.listByInstance(instance.id)[0].actor).toEqual(actor);
		auth.apiTokens.revoke(owner, token.id);
		expect(
			(
				await ctx.app.inject({
					method: "POST",
					url: `/api/processes/${instance.id}/steer`,
					headers,
					payload: { message: "Denied" },
				})
			).statusCode,
		).toBe(401);
		expect(repos.inputs.listByInstance(instance.id)).toHaveLength(1);
		expect(repos.inputs.listByInstance(instance.id)[0].actor).toEqual(actor);
		expect(repos.processes.getById(instance.id)?.lifecycleStatus).toBe("active");
		expect(JSON.stringify(repos.inputs.listByInstance(instance.id))).not.toContain(secret);
	} finally {
		await ctx.app.close();
	}
});
