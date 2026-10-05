import { writeExtensionUiManifest } from "../../../scripts/write-extension-ui-manifest.mjs";

await writeExtensionUiManifest({
	packageDirUrl: new URL("../", import.meta.url),
	modulePaths: { "./poem-leaf-outcome-element.ts": "./assets/poem-leaf-outcome-element.js" },
});
