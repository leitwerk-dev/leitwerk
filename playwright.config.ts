import { type AddressInfo, createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { loadActiveDevelopmentComposition } from "./scripts/development-composition.js";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const composition = loadActiveDevelopmentComposition(repoRoot);
async function freePort() {
	await using server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return String((server.address() as AddressInfo).port);
}

// Workers reload this config; inherit the ports selected by the runner.
process.env.LEITWERK_BROWSER_API_PORT ??= await freePort();
if (!process.env.LEITWERK_BROWSER_UI_PORT) {
	do {
		process.env.LEITWERK_BROWSER_UI_PORT = await freePort();
	} while (process.env.LEITWERK_BROWSER_UI_PORT === process.env.LEITWERK_BROWSER_API_PORT);
}
const API_PORT = process.env.LEITWERK_BROWSER_API_PORT;
const UI_PORT = process.env.LEITWERK_BROWSER_UI_PORT;
const baseURL = `http://127.0.0.1:${UI_PORT}`;

export default defineConfig({
	testDir: "./tests/browser",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: 1,
	reporter: process.env.CI ? "github" : "dot",
	use: {
		baseURL,
		trace: "on-first-retry",
	},
	projects: (
		[
			["chromium", "Desktop Chrome"],
			["firefox", "Desktop Firefox"],
			["webkit", "Desktop Safari"],
		] as const
	).flatMap(([name, device]) =>
		[path.join(repoRoot, "tests/browser"), ...(composition?.testRoots ?? [])].map(
			(testDir, index) => ({
				name: index === 0 ? name : `${name}-composed-${index}`,
				testDir,
				...(index > 0 ? { testMatch: "**/*.browser.test.ts" } : {}),
				use: { ...devices[device], browserName: name },
			}),
		),
	),
	webServer: {
		command: `npm run dev -w @leitwerk-dev/ui -- --host 127.0.0.1 --strictPort --port ${UI_PORT}`,
		url: baseURL,
		reuseExistingServer: false,
		timeout: 30_000,
		stdout: "ignore",
		stderr: "pipe",
		env: {
			LEITWERK_API_HOST: "127.0.0.1",
			LEITWERK_API_PORT: API_PORT,
			LEITWERK_RUNTIME_LANE: "dist",
		},
	},
});

export { API_PORT };
