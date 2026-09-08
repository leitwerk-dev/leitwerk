import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createAuthService } from "../auth/auth-service.js";
import { testAuthConfig } from "../auth/auth-test-helpers.js";
import { hashOpaqueToken } from "../auth/auth-tokens.js";
import { createAes256GcmCredentialCipher } from "./credential-cipher.js";
import { closeDatabase, createDatabase, initializeSchema } from "./database.js";
import { createAllRepos } from "./repositories.js";

it("migrates legacy storage with sessions, processes and encrypted credentials; preserves token revocation after restart", () => {
	const root = mkdtempSync(join(tmpdir(), "leitwerk-api-token-migration-"));
	const sqlitePath = join(root, "state.sqlite");
	const cipher = createAes256GcmCredentialCipher(randomBytes(32));
	const actor = { id: "identity:alice", kind: "user" as const, provider: "identity" };
	const config = testAuthConfig();
	try {
		let db = createDatabase({ sqlitePath });
		let repos = createAllRepos(db, { credentialCipher: cipher });
		repos.authSessions.create({
			idHash: hashOpaqueToken("old-session"),
			actor,
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		});
		repos.providerCredentials.create({
			providerId: "example",
			payload: "encrypted-provider-secret",
		});
		db.$client
			.prepare(
				"INSERT INTO process_instances (id, process_id, created_at, updated_at) VALUES ('existing', 'test', '2026-09-01', '2026-09-01')",
			)
			.run();
		db.$client.exec("DROP TABLE api_tokens");
		closeDatabase(db);
		db = createDatabase({ sqlitePath });
		repos = createAllRepos(db, { credentialCipher: cipher });
		expect(readdirSync(join(root, "backups")).filter((name) => name.endsWith(".bak"))).toHaveLength(
			1,
		);
		expect(repos.providerCredentials.get("example")?.payload).toBe("encrypted-provider-secret");
		expect(repos.processes.getById("existing")?.id).toBe("existing");
		const auth = createAuthService({ config, repos });
		expect(auth.resolveSession("old-session")).toEqual(actor);
		const owner = auth.apiTokens.ownerForActor(actor);
		const created = auth.apiTokens.create(owner, "restart", null);
		expect(readFileSync(sqlitePath).includes(Buffer.from(created.secret))).toBe(false);
		expect(JSON.stringify(db.$client.prepare("SELECT * FROM api_tokens").all())).not.toContain(
			created.secret,
		);
		auth.apiTokens.revoke(owner, created.token.id);
		closeDatabase(db);
		db = createDatabase({ sqlitePath });
		const restarted = createAuthService({
			config,
			repos: createAllRepos(db, { credentialCipher: cipher }),
		});
		expect(restarted.resolveSession("old-session")).toEqual(actor);
		expect(restarted.apiTokens.resolve(created.secret).actor).toBeNull();
		expect(restarted.apiTokens.list(owner)[0].revokedAt).not.toBeNull();
		closeDatabase(db);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
it("the explicit operator migration matches the current schema", () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		initializeSchema(sqlite);
		sqlite.exec("DROP TABLE api_tokens");
		sqlite.exec(
			readFileSync(
				new URL("../../migrations/20260908_add_api_tokens.sql", import.meta.url),
				"utf8",
			),
		);
		expect(() => initializeSchema(sqlite)).not.toThrow();
	} finally {
		sqlite.close();
	}
});
