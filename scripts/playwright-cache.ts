import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Workers inherit the runner's cache; independent runners allocate separate caches. */
export function browserViteCache(env: NodeJS.ProcessEnv = process.env): string {
	env.LEITWERK_BROWSER_VITE_CACHE_DIR ??= mkdtempSync(
		path.join(tmpdir(), "leitwerk-browser-vite-"),
	);
	return env.LEITWERK_BROWSER_VITE_CACHE_DIR;
}

export function removeBrowserViteCache(env: NodeJS.ProcessEnv = process.env): void {
	const cacheDir = env.LEITWERK_BROWSER_VITE_CACHE_DIR;
	if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
	delete env.LEITWERK_BROWSER_VITE_CACHE_DIR;
}

export default function teardown(): void {
	removeBrowserViteCache();
}
