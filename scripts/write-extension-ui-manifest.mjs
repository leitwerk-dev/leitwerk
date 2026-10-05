import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function writeExtensionUiManifest({ packageDirUrl, modulePaths }) {
	const packageDir = fileURLToPath(packageDirUrl);
	const { leitwerk } = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
	const manifest = JSON.parse(await readFile(path.join(packageDir, leitwerk.ui.source), "utf8"));
	for (const renderer of Object.values(manifest.renderers)) {
		const modulePath = modulePaths[renderer.module];
		if (!modulePath) throw new Error(`No built module mapping for '${renderer.module}'`);
		renderer.module = modulePath;
	}
	const manifestPath = path.join(packageDir, leitwerk.ui.import);
	await mkdir(path.dirname(manifestPath), { recursive: true });
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
