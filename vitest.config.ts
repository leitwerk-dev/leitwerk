import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";
import { loadActiveDevelopmentComposition } from "./scripts/development-composition.js";
import { buildWorkspaceSourceAliases } from "./scripts/workspace-source-aliases.js";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
// Keep Vitest from resolving bare Node stream built-ins against the worktree root.
const nodeBuiltinAliases = [
	{ find: /^stream$/, replacement: "node:stream" },
	{ find: /^stream\/promises$/, replacement: "node:stream/promises" },
	{ find: resolve(repoRoot, "stream"), replacement: "node:stream" },
	{ find: resolve(repoRoot, "stream/promises"), replacement: "node:stream/promises" },
];
const nodeBuiltinPlugin = {
	name: "leitwerk-node-builtin-aliases",
	enforce: "pre" as const,
	resolveId(id: string) {
		if (id === "stream" || id === "node:stream" || id === resolve(repoRoot, "stream")) {
			return { id: "node:stream", external: true };
		}
		if (
			id === "stream/promises" ||
			id === "node:stream/promises" ||
			id === resolve(repoRoot, "stream/promises")
		) {
			return { id: "node:stream/promises", external: true };
		}
		return null;
	},
};
const composition = loadActiveDevelopmentComposition(repoRoot);
const externalPackageDirs = composition?.externalPackages.map((entry) => entry.dir) ?? [];
const workspaceSourceAliases = buildWorkspaceSourceAliases(repoRoot, externalPackageDirs);
const externalUnitTests = externalPackageDirs.map((dir) => resolve(dir, "src/**/*.test.ts"));
const externalIntegrationTests = externalPackageDirs.map((dir) =>
	resolve(dir, "src/**/*.integration.test.ts"),
);
const externalUiIntegrationTests = externalPackageDirs.flatMap((dir) => [
	resolve(dir, "src/**/*.ui.integration.test.ts"),
	resolve(dir, "tests/**/*.ui.integration.test.ts"),
]);
const composedE2eTests =
	composition?.testRoots.map((dir) => resolve(dir, "**/*.e2e.test.ts")) ?? [];
const composedIntegrationTests =
	composition?.testRoots.map((dir) => resolve(dir, "**/*.integration.test.ts")) ?? [];
const composedUiIntegrationTests =
	composition?.testRoots.map((dir) => resolve(dir, "**/*.ui.integration.test.ts")) ?? [];
const sharedSetupFiles = [resolve(repoRoot, "tests/vitest.setup.ts")];
// Node 26 emits an ExperimentalWarning for `localStorage` from every forked
// worker during pre-execution (the jsdom projects polyfill it in setup).
// Silence just that warning class so test output stays readable. Applied per
// project because Vitest 4 does not cascade top-level execArgv into projects.
const sharedExecArgv = ["--disable-warning=ExperimentalWarning", "--no-deprecation"];

export default defineConfig({
	plugins: [nodeBuiltinPlugin],
	// Keep vitest on live workspace sources instead of package dist outputs.
	// That prevents stale builds when tests import internal workspace packages.
	resolve: {
		alias: [...nodeBuiltinAliases, ...workspaceSourceAliases],
	},
	test: {
		reporters: ["agent"],
		setupFiles: [resolve(repoRoot, "tests/vitest.setup.ts")],
		execArgv: sharedExecArgv,
		projects: [
			{
				plugins: [nodeBuiltinPlugin],
				resolve: {
					alias: [...nodeBuiltinAliases, ...workspaceSourceAliases],
				},
				test: {
					name: "unit",
					execArgv: sharedExecArgv,
					setupFiles: sharedSetupFiles,
					// Several unit suites bundle temporary Pi resources. More than two workers
					// starve their budgets on shared CI runners even when the same tests take
					// only milliseconds in isolation. The full gate also runs inside 1-CPU
					// delivery workers, where setup can exceed Vitest's 5s default.
					testTimeout: 15_000,
					maxWorkers: 2,
					include: [
						"packages/*/src/**/*.test.ts",
						"extensions/*/src/**/*.test.ts",
						"scripts/**/*.test.ts",
						...externalUnitTests,
					],
					exclude: ["**/*.integration.test.ts", "**/*.e2e.test.ts", "**/*.ui.integration.test.ts"],
				},
			},
			{
				plugins: [nodeBuiltinPlugin],
				resolve: {
					alias: [...nodeBuiltinAliases, ...workspaceSourceAliases],
				},
				test: {
					name: "integration",
					execArgv: sharedExecArgv,
					setupFiles: sharedSetupFiles,
					// Integration files start servers, workers, and resource bundlers. Keep
					// concurrency and timeouts bounded for shared CI and 1-CPU delivery workers.
					testTimeout: 15_000,
					maxWorkers: 2,
					include: [
						"packages/*/src/**/*.integration.test.ts",
						"extensions/*/src/**/*.integration.test.ts",
						"tests/**/*.integration.test.ts",
						...externalIntegrationTests,
						...composedIntegrationTests,
					],
					exclude: ["**/*.ui.integration.test.ts"],
				},
			},
			{
				plugins: [nodeBuiltinPlugin],
				resolve: {
					alias: [...nodeBuiltinAliases, ...workspaceSourceAliases],
				},
				test: {
					name: "e2e",
					execArgv: sharedExecArgv,
					testTimeout: 15_000,
					maxWorkers: 2,
					setupFiles: sharedSetupFiles,
					include: ["tests/**/*.e2e.test.ts", ...composedE2eTests],
				},
			},
			{
				plugins: [
					nodeBuiltinPlugin,
					...svelte({
						configFile: resolve(repoRoot, "packages/ui/svelte.config.js"),
					}),
				],
				resolve: {
					alias: [...nodeBuiltinAliases, ...workspaceSourceAliases],
					conditions: ["browser"],
				},
				test: {
					name: "ui-integration",
					execArgv: sharedExecArgv,
					setupFiles: sharedSetupFiles,
					environment: "jsdom",
					// These tests mount the full Svelte app in jsdom and use the harness
					// `waitFor` helper, which budgets 10s. Keep the per-test timeout above
					// that budget so heavy mounts under concurrent-project load are not
					// killed by Vitest's 5s default before their own waits can complete.
					testTimeout: 30_000,
					// Full-suite jsdom mounts are memory-heavy. Bounding concurrency avoids
					// event-loop starvation that otherwise turns 1-2s interaction tests into
					// intermittent 30s timeouts while a dev server is also running.
					maxWorkers: 2,
					// Provide a concrete origin so jsdom exposes window.localStorage;
					// the default opaque origin leaves it undefined.
					environmentOptions: {
						jsdom: {
							url: "http://localhost/",
						},
					},
					include: [
						"packages/*/src/**/*.ui.integration.test.ts",
						"tests/**/*.ui.integration.test.ts",
						"extensions/*/src/**/*.ui.integration.test.ts",
						"extensions/*/tests/**/*.ui.integration.test.ts",
						...externalUiIntegrationTests,
						...composedUiIntegrationTests,
					],
				},
			},
		],
	},
});
