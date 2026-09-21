import path from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { createFindingsApi } from "./scripts/findings-api";
import { loadReports } from "./scripts/reports";
export default defineConfig({
	plugins: [
		svelte(),
		{
			name: "portable-api-reports",
			configureServer(server) {
				const load = () =>
					loadReports(
						process.env.API_REPORTS_DIR ??
							path.resolve(
								path.dirname(fileURLToPath(import.meta.url)),
								"../../.leitwerk/api-explorer/reports",
							),
					);
				server.middlewares.use(createFindingsApi(load));
				server.middlewares.use("/api/reports", (_request, response) => {
					response.setHeader("Content-Type", "application/json");
					response.setHeader("Cache-Control", "no-store");
					try {
						response.end(JSON.stringify(load()));
					} catch {
						response.statusCode = 500;
						response.end(
							JSON.stringify({ error: "Unable to read reports directory. Check its permissions." }),
						);
					}
				});
			},
		},
	],
	optimizeDeps: { include: ["elkjs/lib/elk-api.js"] },
	server: {
		host: "127.0.0.1",
		port: 4318,
		strictPort: true,
		fs: { strict: true, allow: [path.dirname(fileURLToPath(import.meta.url))] },
		watch: {
			ignored: ["**/public/snapshot.json", "**/public/snapshot.json.tmp", "**/.generated/**"],
		},
	},
});
