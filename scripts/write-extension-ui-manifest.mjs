import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function createCustomElementRenderer({ tagName, modulePath, rendererApiVersion = 1 }) {
	return {
		kind: "custom_element",
		tagName,
		module: modulePath,
		rendererApiVersion,
	};
}

export async function writeExtensionUiManifest({ packageDirUrl, extensionManifestId, renderers }) {
	const packageDir = fileURLToPath(packageDirUrl);
	const outDir = path.join(packageDir, "dist/ui");
	const manifestPath = path.join(outDir, "manifest.json");
	const manifest = {
		apiVersion: 1,
		extensionManifestId,
		renderers,
	};

	await mkdir(outDir, { recursive: true });
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
