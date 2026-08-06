import {
	createCustomElementRenderer,
	writeExtensionUiManifest,
} from "../../../scripts/write-extension-ui-manifest.mjs";

const legacyLeafOutcomeRendererDescriptor = createCustomElementRenderer({
	tagName: "o2-local-repo-change-legacy-leaf-outcome",
	modulePath: "./assets/leaf-outcome-element.js",
});

await writeExtensionUiManifest({
	packageDirUrl: new URL("../", import.meta.url),
	extensionManifestId: "local-repo-change",
	renderers: {
		"@leitwerk-dev/local-repo-change:local_repo_change_process.leaf_outcome":
			legacyLeafOutcomeRendererDescriptor,
	},
});
