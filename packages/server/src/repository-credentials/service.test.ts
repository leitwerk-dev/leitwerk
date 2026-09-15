import { describe, expect, it } from "vitest";
import { RepositoryCredentialService } from "./service.js";

describe("RepositoryCredentialService", () => {
	it("rejects duplicate providers when they are registered", () => {
		const service = new RepositoryCredentialService(new Map());
		const provider = { kind: "git_ssh" as const, resolve: () => null };
		service.register(provider);
		expect(() => service.register(provider)).toThrow("registered more than once");
	});
});

it("authorizes HTTPS material against the project's origin and derives the exact repository scope", async () => {
	const { flow, structuralStateCodec, createEmptyStructuralProcessState } = await import(
		"@leitwerk-dev/process-sdk"
	);
	const process = flow
		.process("https-test")
		.displayName("HTTPS test")
		.entry("run")
		.codecs({ params: { parse: (v) => v, serialize: (v) => v }, state: structuralStateCodec })
		.initialState(createEmptyStructuralProcessState)
		.repositoryCredentials(({ projects }) =>
			projects.map((p) => ({
				projectKey: p.key,
				kind: "git_https",
				credentialRef: "https:fixture",
			})),
		)
		.turn(
			flow
				.automatic("run")
				.description("Run")
				.run(async () => ({ outcome: "done" }))
				.outcome("done", (o) => o.description("Done").complete()),
		)
		.define();
	const service = new RepositoryCredentialService(new Map([[process.id, process]]));
	service.register({
		kind: "git_https",
		resolve: () => ({ origin: "https://forge.test", username: "oauth2", password: "test-token" }),
	});
	const input = {
		processId: process.id,
		paramsJson: "{}",
		projects: [
			{
				key: "repo",
				repoLocator: "https://forge.test/group/subgroup/repo.git",
				baseBranch: "main",
			},
		],
	};
	expect(() => service.validateLaunch(input)).not.toThrow();
	expect(() =>
		service.validateLaunch({
			...input,
			projects: [{ ...input.projects[0]!, repoLocator: "https://other.test/group/repo.git" }],
		}),
	).toThrow("scope");
	expect(() =>
		service.validateLaunch({
			...input,
			projects: [
				{ ...input.projects[0]!, repoLocator: "https://user:password@forge.test/group/repo.git" },
			],
		}),
	).toThrow("credential-free");
});
