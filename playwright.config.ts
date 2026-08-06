import { defineConfig, devices } from "@playwright/test";

const UI_PORT = 5199;
const API_PORT = 8181;

export default defineConfig({
	testDir: "./tests/browser",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: 1,
	reporter: process.env.CI ? "github" : "dot",
	use: {
		baseURL: `http://localhost:${UI_PORT}`,
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command: `npm run dev -w @leitwerk-dev/ui -- --port ${UI_PORT}`,
		url: `http://localhost:${UI_PORT}`,
		reuseExistingServer: !process.env.CI,
		timeout: 30_000,
		stdout: "ignore",
		stderr: "pipe",
		env: {
			LEITWERK_API_PORT: String(API_PORT),
			LEITWERK_RUNTIME_LANE: "dist",
		},
	},
});

export { API_PORT };
