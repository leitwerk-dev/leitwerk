import { type Actor, SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, createInMemoryDatabase, type LeitwerkDb } from "./database.js";
import { createProcessInputRepo } from "./process-input-repo.js";
import { createProcessInstanceRepo } from "./process-instance-repo.js";

describe("process input actor attribution", () => {
	let db: LeitwerkDb;

	beforeEach(() => {
		db = createInMemoryDatabase();
	});

	afterEach(() => {
		closeDatabase(db);
	});

	function createProcess(): string {
		const processes = createProcessInstanceRepo(db);
		return processes.create({ processId: "ticket_issue_process", lifecycleStatus: "active" }).id;
	}

	it("defaults to the system actor when none is provided", () => {
		const inputs = createProcessInputRepo(db);
		const instanceId = createProcess();

		const input = inputs.create({
			instanceId,
			sequence: 1,
			source: "watcher_event",
			kind: "instruction",
			bodyMarkdown: "Reconcile",
		});

		expect(input.actor).toEqual(SYSTEM_ACTOR);
		expect(inputs.listByInstance(instanceId)[0]?.actor).toEqual(SYSTEM_ACTOR);
	});

	it("persists and reads back an explicit user actor", () => {
		const inputs = createProcessInputRepo(db);
		const instanceId = createProcess();
		const actor: Actor = {
			id: "identity:alice",
			kind: "user",
			provider: "identity",
			displayName: "Alice",
		};

		inputs.create({
			instanceId,
			sequence: 1,
			source: "app_steer",
			kind: "instruction",
			bodyMarkdown: "Try a different approach",
			actor,
		});

		expect(inputs.listByInstance(instanceId)[0]?.actor).toEqual(actor);
	});

	it("backfills legacy rows that predate the actor column to the system actor", () => {
		const inputs = createProcessInputRepo(db);
		const instanceId = createProcess();
		const sqlite = (db as unknown as { $client: import("better-sqlite3").Database }).$client;

		// Simulate a row written before the migration default was reliably applied.
		sqlite
			.prepare(
				"INSERT INTO process_inputs (id, instance_id, sequence, source, kind, body_markdown, actor, received_at) " +
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				"inp_legacy",
				instanceId,
				1,
				"external_comment",
				"instruction",
				"old input",
				"",
				"2026-01-01T00:00:00.000Z",
			);

		expect(inputs.listByInstance(instanceId)[0]?.actor).toEqual(SYSTEM_ACTOR);
	});
});
