import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { browserViteCache, removeBrowserViteCache } from "./playwright-cache.js";

it("isolates concurrent runner caches, shares with workers and cleans only the owning cache", () => {
	const first: NodeJS.ProcessEnv = {};
	const second: NodeJS.ProcessEnv = {};
	try {
		const firstCache = browserViteCache(first);
		const secondCache = browserViteCache(second);
		expect(firstCache).not.toBe(secondCache);
		expect(browserViteCache({ ...first })).toBe(firstCache);
		const sentinel = path.join(secondCache, "deps");
		writeFileSync(sentinel, "another runner's dependencies");
		removeBrowserViteCache(first);
		expect(existsSync(firstCache)).toBe(false);
		expect(existsSync(sentinel)).toBe(true);
		expect(first.LEITWERK_BROWSER_VITE_CACHE_DIR).toBeUndefined();
	} finally {
		removeBrowserViteCache(first);
		removeBrowserViteCache(second);
	}
});
