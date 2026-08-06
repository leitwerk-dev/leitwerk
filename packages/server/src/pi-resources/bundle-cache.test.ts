import { createCanonicalPiResourceBundle } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it } from "vitest";
import { createPiResourceBundleCache } from "./bundle-cache.js";

function bundle(name: string, content: string) {
	return createCanonicalPiResourceBundle([{ path: name, content: Buffer.from(content) }]);
}

describe("Pi resource bundle cache", () => {
	it("returns immutable copies and reports missing digests", () => {
		const cache = createPiResourceBundleCache({ maxEntries: 2, maxBytes: 8_192 });
		const stored = bundle("settings.json", "one");
		cache.put(stored);
		const first = cache.get(stored.digest);
		expect(first).not.toBeNull();
		if (first) first.bytes[0] = 0;
		expect(Buffer.from(cache.get(stored.digest)?.bytes ?? [])).toEqual(Buffer.from(stored.bytes));
		expect(cache.get("missing")).toBeNull();
		expect(cache.pin("missing")).toBe(false);
		expect(cache.unpin("missing")).toBe(false);
	});

	it("reference-counts pins and garbage-collects only unpinned bundles", () => {
		const cache = createPiResourceBundleCache({ maxEntries: 4, maxBytes: 16_384 });
		const pinned = bundle("settings.json", "pinned");
		const disposable = bundle("models.json", "disposable");
		cache.put(pinned);
		cache.put(disposable);
		expect(cache.pin(pinned.digest)).toBe(true);
		expect(cache.pin(pinned.digest)).toBe(true);
		expect(cache.unpin(pinned.digest)).toBe(true);

		const collected = cache.gc();
		expect(collected.removedDigests).toEqual([disposable.digest]);
		expect(cache.has(pinned.digest)).toBe(true);
		expect(cache.stats()).toEqual({
			entries: 1,
			bytes: pinned.bytes.length,
			pinnedEntries: 1,
			pins: 1,
		});
		expect(cache.unpin(pinned.digest)).toBe(true);
		expect(cache.gc().removedDigests).toEqual([pinned.digest]);
	});

	it("evicts least-recently-used unpinned entries and preserves pinned capacity", () => {
		const cache = createPiResourceBundleCache({ maxEntries: 2, maxBytes: 16_384 });
		const first = bundle("first", "1");
		const second = bundle("second", "2");
		const third = bundle("third", "3");
		cache.put(first);
		cache.put(second);
		cache.get(first.digest);
		cache.put(third);
		expect(cache.has(first.digest)).toBe(true);
		expect(cache.has(second.digest)).toBe(false);
		expect(cache.has(third.digest)).toBe(true);

		const pinnedOnly = createPiResourceBundleCache({ maxEntries: 1, maxBytes: 8_192 });
		pinnedOnly.put(first);
		pinnedOnly.pin(first.digest);
		expect(() => pinnedOnly.put(second)).toThrow(/capacity is exhausted by pinned bundles/);
		expect(pinnedOnly.has(first.digest)).toBe(true);
		expect(pinnedOnly.has(second.digest)).toBe(false);
	});

	it("rejects mismatched digests and bundles larger than the byte bound", () => {
		const valid = bundle("settings.json", "value");
		const cache = createPiResourceBundleCache({ maxEntries: 1, maxBytes: valid.bytes.length });
		expect(() => cache.put({ digest: "0".repeat(64), bytes: valid.bytes })).toThrow(
			/digest does not match/,
		);
		const tooSmall = createPiResourceBundleCache({
			maxEntries: 1,
			maxBytes: valid.bytes.length - 1,
		});
		expect(() => tooSmall.put(valid)).toThrow(/exceeds cache byte limit/);
	});
});
