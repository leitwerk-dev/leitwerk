# Extension UI renderers

An extension can render leaf outcomes inside supported Chronicle slots. Renderers
receive domain-specific props; they do not own global navigation or replace the
application shell. Use the standard markdown result when no custom presentation
is needed.

## Declare the manifest

Add `leitwerk.ui` next to the extension entry in `package.json`:

```json
{
  "name": "@example/acme-process",
  "leitwerk": {
    "extension": {
      "source": "./src/index.ts",
      "import": "./dist/index.js"
    },
    "ui": {
      "source": "./src/ui/manifest.json",
      "import": "./dist/ui/manifest.json"
    }
  }
}
```

Source development loads the source manifest. Production loads the built manifest
and browser modules; include them in the package's build and published files.

## Register a renderer

The manifest maps a stable renderer ID to a custom element and module:

```json
{
  "apiVersion": 1,
  "extensionManifestId": "acme-process",
  "renderers": {
    "@example/acme-process:acme_process.leaf_outcome": {
      "kind": "custom_element",
      "tagName": "acme-process-leaf-outcome",
      "module": "./leaf-outcome-element.ts",
      "rendererApiVersion": 1
    }
  }
}
```

This is a source manifest; the built manifest must reference the emitted browser
module. Durable leaf-outcome captures use the same `rendererId`. The browser loads
the module when its Chronicle slot is needed.

Renderer and module wire schemas belong to `protocol`. The catalog validates
manifests, and the UI host checks supported renderer versions. Retain stable IDs
for durable results that need to render after an upgrade.

Render within the host's available width. Follow the shared
[interaction and accessibility contracts](ui.md#interaction-and-accessibility),
and keep provider credentials and other secrets out of browser props and modules.
See the
[showcase extension](https://github.com/leitwerk-dev/leitwerk/blob/main/extensions/showcase-processes/README.md#browser-assets)
for source and built asset packaging.
