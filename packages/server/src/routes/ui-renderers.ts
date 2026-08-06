import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { ExtensionUiCatalog } from "../extension-ui/catalog.js";
import {
	inferExtensionUiAssetContentType,
	resolveExtensionUiAssetPath,
} from "../extension-ui/catalog.js";

export interface UiRouteDeps {
	extensionUiCatalog: ExtensionUiCatalog;
	extensionUiAssetCacheControl?: string;
}

export function registerUiRendererRoutes(app: FastifyInstance, deps: UiRouteDeps): void {
	app.get("/api/ui/extensions", async () => ({
		ok: true,
		extensions: deps.extensionUiCatalog.listBrowserModules(),
	}));

	app.get<{ Params: { rendererId: string } }>(
		"/api/ui/renderers/:rendererId",
		async (req, reply) => {
			const descriptor = deps.extensionUiCatalog.getRenderer(req.params.rendererId);
			if (!descriptor) {
				return reply.code(404).send({
					ok: false,
					rendererId: req.params.rendererId,
					code: "renderer_not_found",
					message: "Renderer is not available for any loaded extension UI bundle",
				});
			}
			return reply.send({
				ok: true,
				...descriptor,
			});
		},
	);

	app.get<{ Params: { extensionManifestId: string; "*": string } }>(
		"/ext-ui/:extensionManifestId/*",
		async (req, reply) => {
			const requestedPath = req.params["*"];
			const assetPath = resolveExtensionUiAssetPath(
				deps.extensionUiCatalog,
				req.params.extensionManifestId,
				requestedPath,
			);
			if (!assetPath) {
				return reply.code(404).send({ error: "Asset not found" });
			}
			try {
				const file = await readFile(assetPath);
				reply.header("cache-control", deps.extensionUiAssetCacheControl ?? "public, max-age=60");
				reply.type(inferExtensionUiAssetContentType(assetPath));
				return reply.send(file);
			} catch {
				return reply.code(404).send({ error: "Asset not found" });
			}
		},
	);
}
