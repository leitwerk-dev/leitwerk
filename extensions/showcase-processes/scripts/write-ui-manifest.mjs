import {
	createCustomElementRenderer,
	writeExtensionUiManifest,
} from "../../../scripts/write-extension-ui-manifest.mjs";

await writeExtensionUiManifest({
	packageDirUrl: new URL("../", import.meta.url),
	extensionManifestId: "showcase-processes",
	renderers: {
		"@leitwerk-dev/showcase-processes:poem_creator_process.leaf_outcome":
			createCustomElementRenderer({
				tagName: "o2-showcase-processes-poem-outcome",
				modulePath: "./assets/poem-leaf-outcome-element.js",
			}),
	},
});
