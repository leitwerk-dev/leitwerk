import path from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, normalizePath, type Plugin, searchForWorkspaceRoot } from "vite";
import {
	parseExtensionUiDevSources,
	resolveExtensionUiDevRequest,
} from "./src/extension-ui-dev-server.js";
import { resolveUiDevServerOptions } from "./src/vite-server-config.js";

const apiProtocol = process.env.LEITWERK_API_PROTOCOL || "http";
const wsProtocol = apiProtocol === "https" ? "wss" : "ws";
const apiHost = process.env.LEITWERK_API_HOST || "127.0.0.1";
const apiPort = process.env.LEITWERK_API_PORT || "8080";
const apiTarget = `${apiProtocol}://${apiHost}:${apiPort}`;
const wsTarget = `${wsProtocol}://${apiHost}:${apiPort}`;
const runtimeLane = process.env.LEITWERK_RUNTIME_LANE || "dist";
const resolveConditions = runtimeLane === "source" ? ["source", "browser"] : ["browser"];
const uiDevServer = resolveUiDevServerOptions();
const extensionUiDevSources =
	runtimeLane === "source"
		? parseExtensionUiDevSources(process.env.LEITWERK_DEV_EXTENSION_UI_SOURCES_JSON)
		: [];

function isWithinDirectory(rootDir: string, targetPath: string): boolean {
	const relative = path.relative(rootDir, targetPath);
	return (
		relative === "" ||
		(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
	);
}

function extensionUiSourcePlugin(): Plugin {
	const sourceRoots = extensionUiDevSources.map((source) => source.assetRootDir);
	return {
		name: "leitwerk-extension-ui-source",
		configureServer(server) {
			if (sourceRoots.length === 0) return;
			server.middlewares.use((request, _response, next) => {
				if (
					(request.method === "GET" || request.method === "HEAD") &&
					typeof request.url === "string"
				) {
					const resolved = resolveExtensionUiDevRequest(request.url, extensionUiDevSources);
					if (resolved) {
						request.url = `/@fs/${normalizePath(resolved.filePath)}${resolved.search}`;
					}
				}
				next();
			});

			let reloadTimer: NodeJS.Timeout | null = null;
			server.watcher.add(sourceRoots);
			server.watcher.on("all", (event, filePath) => {
				if (event !== "add" && event !== "change" && event !== "unlink") return;
				const resolvedPath = path.resolve(filePath);
				if (!sourceRoots.some((sourceRoot) => isWithinDirectory(sourceRoot, resolvedPath))) return;
				if (reloadTimer) clearTimeout(reloadTimer);
				reloadTimer = setTimeout(() => server.ws.send({ type: "full-reload" }), 75);
			});
		},
	};
}

export default defineConfig({
	plugins: [svelte(), extensionUiSourcePlugin()],
	resolve: {
		alias: [
			{
				find: "beautiful-mermaid",
				replacement: path.resolve(
					import.meta.dirname,
					"../../node_modules/beautiful-mermaid/src/index.ts",
				),
			},
			{
				find: "./elk-instance.ts",
				replacement: path.resolve(import.meta.dirname, "src/lib/beautiful-mermaid-elk-instance.ts"),
			},
			{
				find: "elkjs/lib/elk.bundled.js",
				replacement: path.resolve(import.meta.dirname, "src/lib/elk-bundled-worker.ts"),
			},
		],
		conditions: resolveConditions,
	},
	optimizeDeps: {
		exclude: ["beautiful-mermaid"],
		include: ["@dagrejs/dagre", "dompurify", "elkjs/lib/elk-api.js", "markdown-it"],
	},
	server: {
		host: process.env.LEITWERK_UI_HOST ?? "localhost",
		port: uiDevServer.port,
		strictPort: uiDevServer.strictPort,
		fs:
			extensionUiDevSources.length > 0
				? {
						allow: [
							searchForWorkspaceRoot(import.meta.dirname),
							...new Set(extensionUiDevSources.map((source) => source.packageRootDir)),
						],
					}
				: undefined,
		proxy: {
			"/api": apiTarget,
			...(runtimeLane === "source" ? {} : { "/ext-ui": apiTarget }),
			"/ws": {
				target: wsTarget,
				ws: true,
			},
		},
	},
	build: {
		outDir: "dist",
	},
});
