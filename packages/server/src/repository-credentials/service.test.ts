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
