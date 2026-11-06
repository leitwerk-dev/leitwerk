import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAuthService } from "../auth/auth-service.js";
import { testAuthConfig, testOidcEvidence } from "../auth/auth-test-helpers.js";
import { hashOpaqueToken } from "../auth/auth-tokens.js";
import { createOwnedDatabaseScope } from "../test-helpers/owned-test-deps.js";
import { closeDatabase, initializeSchema } from "./database.js";
import { createAllRepos } from "./repositories.js";

const { createDatabase, closeOwnedSqlite, openOwnedSqlite } = createOwnedDatabaseScope();

it("migrates file-backed sessions and tokens without evidence, preserves data and requires reauthentication", () => {
	const root = mkdtempSync(join(tmpdir(), "leitwerk-oidc-evidence-"));
	const sqlitePath = join(root, "state.sqlite");
	try {
		let db = createDatabase({ sqlitePath });
		let repos = createAllRepos(db);
		const config = testAuthConfig();
		const actor = { id: "identity:alice", kind: "user" as const, provider: "identity" };
		const auth = createAuthService({ config, repos });
		const token = auth.apiTokens.create(
			auth.apiTokens.ownerForActor(actor, testOidcEvidence()),
			"legacy token",
			null,
		);
		repos.authSessions.create({
			idHash: hashOpaqueToken("legacy"),
			actor,
			oidcEvidence: testOidcEvidence(),
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		});
		db.$client.exec(
			"INSERT INTO process_instances (id, process_id, created_at, updated_at) VALUES ('retained', 'test', '2026-09-01', '2026-09-01')",
		);
		db.$client.exec(
			"ALTER TABLE auth_sessions DROP COLUMN oidc_evidence_json; ALTER TABLE api_tokens DROP COLUMN oidc_evidence_json",
		);
		closeDatabase(db);
		db = createDatabase({ sqlitePath });
		repos = createAllRepos(db);
		expect(readdirSync(join(root, "backups")).filter((name) => name.endsWith(".bak"))).toHaveLength(
			1,
		);
		expect(repos.processes.getById("retained")?.id).toBe("retained");
		expect(repos.authSessions.getValid(hashOpaqueToken("legacy"))?.actor).toEqual(actor);
		expect(
			repos.apiTokens.list({ kind: "user", id: actor.id, actor, providerBinding: null })[0].name,
		).toBe("legacy token");
		const restarted = createAuthService({ config, repos });
		expect(restarted.resolveSession("legacy")).toBeNull();
		expect(restarted.apiTokens.resolve(token.secret).actor).toBeNull();
		closeDatabase(db);
	} finally {
		closeOwnedSqlite();
		rmSync(root, { recursive: true, force: true });
	}
});

it("applies the explicit operator migration to the same target schema", () => {
	const sqlite = openOwnedSqlite(":memory:");
	try {
		initializeSchema(sqlite);
		sqlite.exec(
			"ALTER TABLE auth_sessions DROP COLUMN oidc_evidence_json; ALTER TABLE api_tokens DROP COLUMN oidc_evidence_json",
		);
		sqlite.exec(
			readFileSync(
				new URL("../../migrations/20260909_add_oidc_evidence.sql", import.meta.url),
				"utf8",
			),
		);
		expect(() => initializeSchema(sqlite)).not.toThrow();
	} finally {
		sqlite.close();
	}
});
