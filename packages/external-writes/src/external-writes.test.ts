import type { ExternalWriteType } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import {
	createWriteIdentity,
	type ExternalWriteLogRecordInput,
	type ExternalWriteLogRepoLike,
	ensureWrite,
	recordWriteIfMissing,
	type WriteIdentity,
} from "./external-writes.js";

const instanceId = "agt_1";

const id = (writeType: ExternalWriteType, dedupKey: string): WriteIdentity =>
	createWriteIdentity(writeType, dedupKey);

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

		const first = await ensureWrite(repo, instanceId, identity, async () => {
			callCount++;
			return { ok: true };
		});
		const second = await ensureWrite(repo, instanceId, identity, async () => {
			callCount++;
			return { ok: true };
		});

		expect(first.performed).toBe(true);
		expect(second.performed).toBe(false);
		expect(callCount).toBe(1);
	});
});

describe("recordWriteIfMissing", () => {
	it("records completion metadata without rerunning external work", () => {
		const repo = createWriteLogRepo();
		const identity = id("type.gamma", "gamma:1");

		const first = recordWriteIfMissing(repo, instanceId, identity, { attempt: 1 });
		const second = recordWriteIfMissing(repo, instanceId, identity, { attempt: 1 });

		expect(first.performed).toBe(true);
		expect(second.performed).toBe(false);
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
		expect(recordWriteIfMissing(repo, instanceId, id1).performed).toBe(false);
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
			expect(recordWriteIfMissing(repo2, instanceId, identity).performed).toBe(false);
		}
	});
});
