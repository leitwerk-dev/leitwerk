import {
	createCustomElementRenderer,
	writeExtensionUiManifest,
} from "../../../scripts/write-extension-ui-manifest.mjs";

await writeExtensionUiManifest({
	packageDirUrl: new URL("../", import.meta.url),
	extensionManifestId: "example-processes",
	renderers: {
		"@leitwerk-dev/showcase-processes:single_prompt_process.leaf_outcome":
			createCustomElementRenderer({
				tagName: "o2-showcase-processes-leaf-outcome",
				modulePath: "./assets/leaf-outcome-element.js",
			}),
		"@leitwerk-dev/showcase-processes:single_prompt_with_tool_process.leaf_outcome":
			createCustomElementRenderer({
				tagName: "o2-showcase-processes-leaf-outcome",
				modulePath: "./assets/leaf-outcome-element.js",
			}),
	},
});
