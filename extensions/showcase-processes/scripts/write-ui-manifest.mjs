import {
	createCustomElementRenderer,
	writeExtensionUiManifest,
} from "../../../scripts/write-extension-ui-manifest.mjs";

const genericRendererDescriptor = createCustomElementRenderer({
	tagName: "o2-showcase-processes-leaf-outcome",
	modulePath: "./assets/leaf-outcome-element.js",
});

const poemRendererDescriptor = createCustomElementRenderer({
	tagName: "o2-showcase-processes-poem-outcome",
	modulePath: "./assets/poem-leaf-outcome-element.js",
});

await writeExtensionUiManifest({
	packageDirUrl: new URL("../", import.meta.url),
	extensionManifestId: "showcase-processes",
	renderers: {
		"@leitwerk-dev/showcase-processes:single_prompt_process.leaf_outcome":
			genericRendererDescriptor,
		"@leitwerk-dev/showcase-processes:single_prompt_with_tool_process.leaf_outcome":
			genericRendererDescriptor,
		"@leitwerk-dev/showcase-processes:poem_creator_process.leaf_outcome": poemRendererDescriptor,
	},
});
