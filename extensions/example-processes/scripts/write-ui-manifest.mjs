import { writeExtensionUiManifest } from "../../../scripts/write-extension-ui-manifest.mjs";

await writeExtensionUiManifest({
	packageDirUrl: new URL("../", import.meta.url),
	modulePaths: { "./leaf-outcome-element.ts": "./assets/leaf-outcome-element.js" },
});
