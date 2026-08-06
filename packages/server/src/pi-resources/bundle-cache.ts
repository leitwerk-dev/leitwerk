import { type PiResourceBundle, sha256Digest } from "@leitwerk-dev/worker-protocol";

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

interface CacheEntry {
	readonly digest: string;
	readonly bytes: Uint8Array;
	readonly size: number;
	pins: number;
	lastAccess: number;
}

export interface PiResourceBundleCacheOptions {
	readonly maxEntries?: number;
	readonly maxBytes?: number;
}

export interface PiResourceBundleCacheStats {
	readonly entries: number;
	readonly bytes: number;
	readonly pinnedEntries: number;
	readonly pins: number;
}

export interface PiResourceBundleCacheGcResult {
	readonly removedDigests: readonly string[];
	readonly removedBytes: number;
}

export interface PiResourceBundleCache {
	put(bundle: PiResourceBundle): void;
	get(digest: string): PiResourceBundle | null;
	has(digest: string): boolean;
	pin(digest: string): boolean;
	unpin(digest: string): boolean;
	gc(): PiResourceBundleCacheGcResult;
	stats(): PiResourceBundleCacheStats;
}

function positiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 1) {
		throw new Error(`${name} must be a positive safe integer`);
	}
	return result;
}

function copyBundle(entry: CacheEntry): PiResourceBundle {
	return { digest: entry.digest, bytes: Uint8Array.from(entry.bytes) };
}

/** In-memory operational cache. Bundles are immutable copies and pins are reference-counted. */
export function createPiResourceBundleCache(
	options: PiResourceBundleCacheOptions = {},
): PiResourceBundleCache {
	const maxEntries = positiveSafeInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries");
	const maxBytes = positiveSafeInteger(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
	const entries = new Map<string, CacheEntry>();
	let totalBytes = 0;
	let accessSequence = 0;

	function oldestUnpinned(excluding?: string): CacheEntry | null {
		let oldest: CacheEntry | null = null;
		for (const entry of entries.values()) {
			if (entry.digest === excluding || entry.pins > 0) continue;
			if (
				oldest === null ||
				entry.lastAccess < oldest.lastAccess ||
				(entry.lastAccess === oldest.lastAccess && entry.digest < oldest.digest)
			) {
				oldest = entry;
			}
		}
		return oldest;
	}

	function remove(entry: CacheEntry): void {
		if (!entries.delete(entry.digest)) return;
		totalBytes -= entry.size;
	}

	function enforceBounds(newDigest: string): void {
		while (entries.size > maxEntries || totalBytes > maxBytes) {
			const candidate = oldestUnpinned(newDigest);
			if (!candidate) {
				const inserted = entries.get(newDigest);
				if (inserted?.pins === 0) remove(inserted);
				throw new Error("Pi resource bundle cache capacity is exhausted by pinned bundles");
			}
			remove(candidate);
		}
	}

	return {
		put(bundle: PiResourceBundle): void {
			if (typeof bundle.digest !== "string" || sha256Digest(bundle.bytes) !== bundle.digest) {
				throw new Error("Pi resource bundle digest does not match its bytes");
			}
			if (bundle.bytes.byteLength > maxBytes) {
				throw new Error(
					`Pi resource bundle size ${bundle.bytes.byteLength} exceeds cache byte limit ${maxBytes}`,
				);
			}
			const existing = entries.get(bundle.digest);
			if (existing) {
				existing.lastAccess = ++accessSequence;
				return;
			}
			const bytes = Uint8Array.from(bundle.bytes);
			const entry: CacheEntry = {
				digest: bundle.digest,
				bytes,
				size: bytes.byteLength,
				pins: 0,
				lastAccess: ++accessSequence,
			};
			entries.set(entry.digest, entry);
			totalBytes += entry.size;
			enforceBounds(entry.digest);
		},

		get(digest: string): PiResourceBundle | null {
			const entry = entries.get(digest);
			if (!entry) return null;
			entry.lastAccess = ++accessSequence;
			return copyBundle(entry);
		},

		has: (digest: string): boolean => entries.has(digest),

		pin(digest: string): boolean {
			const entry = entries.get(digest);
			if (!entry) return false;
			entry.pins += 1;
			entry.lastAccess = ++accessSequence;
			return true;
		},

		unpin(digest: string): boolean {
			const entry = entries.get(digest);
			if (!entry || entry.pins === 0) return false;
			entry.pins -= 1;
			entry.lastAccess = ++accessSequence;
			return true;
		},

		gc(): PiResourceBundleCacheGcResult {
			const removed = [...entries.values()]
				.filter((entry) => entry.pins === 0)
				.sort(
					(left, right) =>
						left.lastAccess - right.lastAccess || left.digest.localeCompare(right.digest),
				);
			let removedBytes = 0;
			for (const entry of removed) {
				removedBytes += entry.size;
				remove(entry);
			}
			return {
				removedDigests: removed.map((entry) => entry.digest),
				removedBytes,
			};
		},

		stats(): PiResourceBundleCacheStats {
			const values = [...entries.values()];
			return {
				entries: entries.size,
				bytes: totalBytes,
				pinnedEntries: values.filter((entry) => entry.pins > 0).length,
				pins: values.reduce((total, entry) => total + entry.pins, 0),
			};
		},
	};
}
