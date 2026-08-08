import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const GLOBAL_HOME_DIR_KEY = "__leitwerkV2VitestPiHomeDir";
const globalState = globalThis as typeof globalThis & {
	[GLOBAL_HOME_DIR_KEY]?: string;
};

process.env.LEITWERK_TEST_HOST_HOME ??= process.env.HOME;

if (!globalState[GLOBAL_HOME_DIR_KEY]) {
	// Keep the test Pi home isolated so Leitwerk's managed ~/.pi/leitwerk
	// location stays away from a developer's real Pi config and extensions.
	const homeDir = mkdtempSync(path.join(os.tmpdir(), "leitwerk-pi-home-"));
	const processDir = path.join(homeDir, ".pi", "process");

	for (const child of ["extensions", "skills", "prompts", "themes", "sessions"]) {
		mkdirSync(path.join(processDir, child), { recursive: true });
	}

	globalState[GLOBAL_HOME_DIR_KEY] = homeDir;
}

process.env.HOME = globalState[GLOBAL_HOME_DIR_KEY];
process.env.USERPROFILE = globalState[GLOBAL_HOME_DIR_KEY];
delete process.env.PI_CODING_AGENT_DIR;

// Node 26's TextEncoder returns Node's Uint8Array while Vitest's jsdom
// environment replaces the global constructor with the window-realm one.
// esbuild correctly requires those constructors to agree. Reuse the encoder's
// native constructor rather than installing a TextEncoder/polyfill.
if (typeof window !== "undefined") {
	const encodedEmptyString = new TextEncoder().encode("");
	if (!(encodedEmptyString instanceof Uint8Array)) {
		Object.defineProperty(globalThis, "Uint8Array", {
			value: Object.getPrototypeOf(encodedEmptyString).constructor,
			configurable: true,
		});
	}
}

// Overriding HOME above leaves git without a user identity. On macOS git then
// falls back to a directory-services lookup to synthesize the committer ident,
// which blocks for ~5s before timing out on every clone/commit. Provide a
// deterministic identity so git-heavy tests don't pay that stall per subprocess.
process.env.GIT_AUTHOR_NAME ??= "Leitwerk Test";
process.env.GIT_AUTHOR_EMAIL ??= "test@leitwerk.local";
process.env.GIT_COMMITTER_NAME ??= "Leitwerk Test";
process.env.GIT_COMMITTER_EMAIL ??= "test@leitwerk.local";

// vitest 4's jsdom environment on Node 26 no longer exposes window.localStorage,
// so polyfill an in-memory Storage in browser-like environments. This is a no-op
// in the node-based unit/integration projects where window is undefined.
if (typeof window !== "undefined" && !window.localStorage) {
	class MemoryStorage implements Storage {
		private store = new Map<string, string>();
		get length(): number {
			return this.store.size;
		}
		clear(): void {
			this.store.clear();
		}
		getItem(key: string): string | null {
			return this.store.has(key) ? (this.store.get(key) as string) : null;
		}
		setItem(key: string, value: string): void {
			this.store.set(key, String(value));
		}
		removeItem(key: string): void {
			this.store.delete(key);
		}
		key(index: number): string | null {
			return Array.from(this.store.keys())[index] ?? null;
		}
	}
	Object.defineProperty(window, "localStorage", {
		value: new MemoryStorage(),
		configurable: true,
	});
	Object.defineProperty(window, "sessionStorage", {
		value: new MemoryStorage(),
		configurable: true,
	});
}
