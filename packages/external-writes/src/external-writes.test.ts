import type { ExternalWriteType } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import type { WriteIdentity } from "./contracts.js";
import {
	bindExternalWrites,
	type ExternalWriteLogRecordInput,
	type ExternalWriteLogRepoLike,
	ensureWrite,
	recordWriteIfMissing,
} from "./external-writes.js";

const instanceId = "agt_1";

const id = (writeType: ExternalWriteType, dedupKey: string): WriteIdentity => ({
	writeType,
	dedupKey,
});

const notification = (
	instanceId: string,
	channelKey: string,
	logicalEventKey: string,
): WriteIdentity =>
	id("notification", `${instanceId}:notification:${channelKey}:${logicalEventKey}`);

function createWriteLogRepo(
	state: Map<string, ExternalWriteLogRecordInput> = new Map(),
): ExternalWriteLogRepoLike {
	return {
		hasDedupKey(dedupKey: string) {
			return state.has(dedupKey);
		},
		record(input: ExternalWriteLogRecordInput) {
			if (state.has(input.dedupKey)) {
				throw new Error(`duplicate dedup key: ${input.dedupKey}`);
			}
			state.set(input.dedupKey, input);
			return input;
		},
	};
}
describe("ensureWrite", () => {
	it("performs the async write on first call and skips the duplicate", async () => {
		const repo = createWriteLogRepo();
		const identity = id("type.beta", "beta:1");
		let callCount = 0;

		const first = await bindExternalWrites(repo, instanceId).logOnly(identity, async () => {
			callCount++;
			return { ok: true };
		});
		const second = await bindExternalWrites(repo, instanceId).logOnly(identity, async () => {
			callCount++;
			return { ok: true };
		});

		expect(first).toBeUndefined();
		expect(second).toBeUndefined();
		expect(callCount).toBe(1);
	});
});

describe("recordWriteIfMissing", () => {
	it("records completion metadata without rerunning external work", () => {
		const repo = createWriteLogRepo();
		const identity = id("type.gamma", "gamma:1");

		const first = recordWriteIfMissing(repo, instanceId, identity, { attempt: 1 });
		const second = recordWriteIfMissing(repo, instanceId, identity, { attempt: 1 });

		expect(first.recorded).toBe(true);
		expect(second.recorded).toBe(false);
		expect(repo.hasDedupKey(identity.dedupKey)).toBe(true);
	});
});

describe("distinct identities", () => {
	it("treats different dedup keys as separate writes", () => {
		const repo = createWriteLogRepo();
		const id1 = id("type.alpha", "shared:1");
		const id2 = id("type.alpha", "shared:2");
		const id3 = id("type.beta", "shared:1");

		expect(id1.dedupKey).not.toBe(id2.dedupKey);
		expect(id1.writeType).not.toBe(id3.writeType);

		recordWriteIfMissing(repo, instanceId, id1);
		recordWriteIfMissing(repo, instanceId, id2);
		recordWriteIfMissing(repo, instanceId, id3);

		expect(repo.hasDedupKey(id1.dedupKey)).toBe(true);
		expect(repo.hasDedupKey(id2.dedupKey)).toBe(true);
		expect(repo.hasDedupKey(id3.dedupKey)).toBe(true);
	});
});

describe("notifications", () => {
	it("deduplicates by channel and logical event key", () => {
		const repo = createWriteLogRepo();
		const id1 = notification(instanceId, "all", "turn_selected:generate_plan");
		const id2 = notification(instanceId, "debug", "turn_selected:generate_plan");

		recordWriteIfMissing(repo, instanceId, id1);
		recordWriteIfMissing(repo, instanceId, id2);

		expect(id1.dedupKey).not.toBe(id2.dedupKey);
		expect(recordWriteIfMissing(repo, instanceId, id1).recorded).toBe(false);
	});
});

describe("restart behavior", () => {
	it("preserves deduplication across fresh repo instances", () => {
		const sharedState = new Map<string, ExternalWriteLogRecordInput>();
		const repo1 = createWriteLogRepo(sharedState);
		const identities = [
			id("type.alpha", "alpha:1"),
			id("type.beta", "beta:1"),
			notification(instanceId, "all", "turn_selected:generate_plan"),
		];

		for (const identity of identities) {
			recordWriteIfMissing(repo1, instanceId, identity);
		}

		const repo2 = createWriteLogRepo(sharedState);
		for (const identity of identities) {
			expect(recordWriteIfMissing(repo2, instanceId, identity).recorded).toBe(false);
		}
	});
});

function reconciliationFixture(state = new Map<string, ExternalWriteLogRecordInput>()) {
	const repo = createWriteLogRepo(state);
	const identity = id("test.create", "remote:1");
	let remote: { id: number } | null = null;
	let executions = 0;
	const phases: string[] = [];
	const operation = {
		mode: "reconcile" as const,
		reconcile: async (phase: string) => {
			phases.push(phase);
			return remote;
		},
		execute: async () => {
			executions++;
			remote = { id: 42 };
			return remote;
		},
		toMetadata: (value: { id: number }) => ({ remoteId: value.id }),
	};
	return {
		repo,
		identity,
		operation,
		phases,
		state,
		run: () => bindExternalWrites(repo, instanceId).ensure(identity, operation),
		get executions() {
			return executions;
		},
		set remote(value: { id: number } | null) {
			remote = value;
		},
	};
}

describe("typed reconciliation", () => {
	it("executes, records metadata and recovers the typed value on replay", async () => {
		const f = reconciliationFixture();
		expect(await f.run()).toEqual({ id: 42 });
		expect(await f.run()).toEqual({ id: 42 });
		expect(f.state.get("remote:1")?.metadata).toEqual({ remoteId: 42 });
		expect(f.phases).toEqual(["before_execute", "already_recorded"]);
		expect(f.executions).toBe(1);
	});
	it("records a pre-existing remote object", async () => {
		const f = reconciliationFixture();
		f.remote = { id: 9 };
		expect(await f.run()).toMatchObject({ id: 9 });
		expect(f.executions).toBe(0);
	});
	it("never recreates a logged object that disappeared", async () => {
		const f = reconciliationFixture();
		await f.run();
		f.remote = null;
		await expect(f.run()).rejects.toMatchObject({
			name: "ExternalWriteMissingRemoteError",
			identity: f.identity,
		});
		expect(f.executions).toBe(1);
	});
	it("recovers a lost execution response", async () => {
		const f = reconciliationFixture();
		const execute = f.operation.execute;
		f.operation.execute = async () => {
			await execute();
			throw new Error("lost response");
		};
		expect(await f.run()).toMatchObject({ id: 42 });
		expect(f.phases).toEqual(["before_execute", "after_execute_error"]);
		expect(f.executions).toBe(1);
	});
	it("does not execute after a failed preflight lookup", async () => {
		const f = reconciliationFixture();
		const error = new Error("lookup");
		f.operation.reconcile = async () => {
			throw error;
		};
		await expect(f.run()).rejects.toBe(error);
		expect(f.executions).toBe(0);
	});
	it("rethrows the original execution error when recovery finds nothing", async () => {
		const f = reconciliationFixture();
		const error = new Error("execution");
		f.operation.execute = async () => {
			throw error;
		};
		await expect(f.run()).rejects.toBe(error);
		expect(f.phases).toEqual(["before_execute", "after_execute_error"]);
	});
	it.each([
		"lookup",
		"metadata",
		"record",
	])("retains both execution and %s failures", async (failure) => {
		const f = reconciliationFixture();
		const execution = new Error("execution");
		const recovery = new Error(failure);
		f.operation.execute = async () => {
			f.remote = { id: 42 };
			throw execution;
		};
		if (failure === "lookup")
			f.operation.reconcile = async (phase) => {
				if (phase === "after_execute_error") throw recovery;
				return null;
			};
		if (failure === "metadata")
			f.operation.toMetadata = () => {
				throw recovery;
			};
		if (failure === "record")
			f.repo.record = () => {
				throw recovery;
			};
		await expect(f.run()).rejects.toMatchObject({
			errors: [execution, recovery],
			cause: execution,
		});
	});
	it.each([
		"metadata",
		"record",
	])("recovers after %s failure through a fresh repository", async (failure) => {
		const f = reconciliationFixture();
		const error = new Error(failure);
		const metadata = f.operation.toMetadata;
		if (failure === "metadata")
			f.operation.toMetadata = () => {
				throw error;
			};
		else
			f.repo.record = () => {
				throw error;
			};
		await expect(f.run()).rejects.toBe(error);
		expect(f.phases).toEqual(["before_execute"]);
		f.operation.toMetadata = metadata;
		const result = await ensureWrite(
			createWriteLogRepo(f.state),
			instanceId,
			f.identity,
			f.operation,
		);
		expect(result).toEqual({ id: 42 });
		expect(f.executions).toBe(1);
	});
	it("serializes the same key while independent keys proceed", async () => {
		const f = reconciliationFixture();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const execute = f.operation.execute;
		f.operation.execute = async () => {
			await gate;
			return execute();
		};
		const first = f.run();
		const second = f.run();
		const independent = await ensureWrite(f.repo, instanceId, id("test.other", "other"), {
			mode: "log_only",
			execute: async () => ({}),
		});
		expect(independent).toBeUndefined();
		release();
		expect(await Promise.all([first, second])).toEqual([{ id: 42 }, { id: 42 }]);
		expect(f.executions).toBe(1);
	});
	it("releases the queue after failure", async () => {
		const f = reconciliationFixture();
		const execute = f.operation.execute;
		let first = true;
		f.operation.execute = async () => {
			if (first) {
				first = false;
				throw new Error("failed");
			}
			return execute();
		};
		const results = await Promise.allSettled([f.run(), f.run()]);
		expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
		expect(f.executions).toBe(1);
	});
	it("accepts a duplicate inserted during recording", async () => {
		const f = reconciliationFixture();
		f.repo.record = (input) => {
			f.state.set(input.dedupKey, input);
			throw new Error("duplicate");
		};
		expect(await f.run()).toEqual({ id: 42 });
		expect(await f.run()).toEqual({ id: 42 });
	});
});
