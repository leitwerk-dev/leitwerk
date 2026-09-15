import type { RepositoryCredentialProvider, ServerExtensionAPI } from "@leitwerk-dev/process-sdk";
import { createTestServerSetupCapability } from "@leitwerk-dev/test-support";
import { describe, expect, it, vi } from "vitest";
import extension, { type GitLabIntegration, gitlabRepositoryCredentials } from "./index.js";

describe("one GitLab profile", () => {
	it("supplies API and internal HTTPS Git authentication with the same token", async () => {
		const providers: RepositoryCredentialProvider[] = [];
		const deps = createTestServerSetupCapability({
			repositoryCredentials: { register: (p) => providers.push(p) },
		});
		const supplied: GitLabIntegration[] = [];
		const api = {
			get: () => deps,
			provide: (_token: unknown, value: GitLabIntegration) => supplied.push(value),
			tool: () => {},
		} as unknown as ServerExtensionAPI;
		const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: 1 }));
		try {
			await extension.setupServer?.(api, {
				profiles: { example: { base_url: "https://forge.test", token: "profile-secret" } },
			});
			const client = supplied[0]?.client("example");
			if (!client) throw new Error("Missing integration");
			await client.getProject("a/b");
			expect(request).toHaveBeenCalledWith(
				"https://forge.test/api/v4/projects/a%2Fb",
				expect.objectContaining({
					headers: expect.objectContaining({ "PRIVATE-TOKEN": "profile-secret" }),
				}),
			);
			expect(providers[0]?.resolve("gitlab:example")).toEqual({
				origin: "https://forge.test",
				username: "oauth2",
				password: "profile-secret",
			});
			expect(
				gitlabRepositoryCredentials("example", [
					{
						key: "repo",
						repoLocator: "https://forge.test/a/b.git",
						baseBranch: "main",
						workBranch: null,
					},
				]),
			).toEqual([{ projectKey: "repo", kind: "git_https", credentialRef: "gitlab:example" }]);
			expect(JSON.stringify(client)).not.toContain("profile-secret");
		} finally {
			request.mockRestore();
		}
	});
});
