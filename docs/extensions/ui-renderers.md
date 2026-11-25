# Extension UI renderers

Extensions can customize how tool calls, leaf outcomes, and small shell controls appear in the browser UI without replacing global navigation or the application shell. Use standard Markdown results whenever custom presentation is unnecessary.

## Declarative tool call renderers

For custom formatting of tool arguments or results inside Chronicle traces, register a `ToolCallRendererDefinition` in `setupCatalog` — no browser bundle required:

```ts
api.registerToolRenderer({
  toolName: "leave_feedback",
  title: "Feedback",
  fields: [
    {
      id: "summary",
      label: "Summary",
      kind: "markdown",
      source: "arguments",
      path: "summary",
    },
  ],
});
```

Each field declares a unique `id`, non-empty `label`, `kind` (`"markdown"`, `"plaintext"`, or `"json"`), `source` (`"arguments"` or `"result"`), and optional dot-separated `path`.

## Declaring a browser UI manifest

For custom elements or browser shell modules, add `leitwerk.ui` next to `leitwerk.extension` in `package.json`:

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

Source development loads `source`; production loads `import` and its emitted browser modules (include them in your build output and npm `files`).

### Manifest schema

A UI manifest declares leaf-outcome custom elements (`renderers`) and/or shell extension modules (`browserModules`):

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
  },
  "browserModules": [
    {
      "module": "./shell.ts",
      "browserApiVersion": 1
    }
  ]
}
```

In the built manifest (`dist/ui/manifest.json`), point `module` at the emitted `.js` bundles. The server catalog validates manifests and the UI host checks supported `rendererApiVersion` and `browserApiVersion` values (mismatched versions are skipped with a warning).

## Leaf-outcome custom elements

### Server capture (`LeafOutcomeCaptureContext`)

Attach a durable capture hook via `ui(api) { api.leafOutcome({ rendererId, capture(ctx) }) }`, returning `{ rendererId, schemaVersion?, props, fallbackMarkdown? }` or `null`. Keep `rendererId` stable across upgrades so historical results continue to render.

`capture(ctx)` receives `process`, `projects`, `params`, `state`, plus:

| Member | Purpose |
| --- | --- |
| `leaf` | `{ entryId, turnRecordId }` of the captured leaf entry. |
| `turnRecord` | `ProcessTurnRecord \| null` for the captured leaf. |
| `mappedResult?` | Accepted result of the current mapped LLM item, when available. |
| `readLeafEntry()` | Reads the captured `PiTreeEntry \| null`. |
| `readTreeEntry(entryId)` | Reads any `PiTreeEntry \| null` in the instance tree. |
| `readTurnRecord(turnRecordId)` | Reads a `ProcessTurnRecord \| null` by ID. |

Never put credentials or secrets into captured `props` or browser modules.

### Custom element base (`@leitwerk-dev/process-sdk/leaf-outcome-renderer`)

Extend `LeafOutcomeCustomElement<TPayload>` and register the declared `tagName` with `customElements.define`:

```ts
import {
  escapeLeafOutcomeHtml,
  LeafOutcomeCustomElement,
  normalizeLeafOutcomeOptionalText,
} from "@leitwerk-dev/process-sdk/leaf-outcome-renderer";

interface DraftPayload {
  title?: string;
  bodyMarkdown: string;
}

class AcmeOutcomeElement extends LeafOutcomeCustomElement<DraftPayload> {
  protected renderContent(): void {
    if (!this.canRender() || !this.payload) return;
    const title = normalizeLeafOutcomeOptionalText(this.payload.title);
    const html = this.runtime.markdown.render(this.payload.bodyMarkdown);
    this.shadowRootRef.innerHTML = `${title ? `<h3>${escapeLeafOutcomeHtml(title)}</h3>` : ""}${html}`;
    this.emitReady();
  }
}

if (!customElements.get("acme-process-leaf-outcome")) {
  customElements.define("acme-process-leaf-outcome", AcmeOutcomeElement);
}
```

Available members and helpers:

- `this.payload`, `this.meta` (`instanceId`, `snapshotId`, `leafEntryId`, `turnRecordId`, `createdAt`, `schemaVersion`, `lifecycleStatus?`, `selectedTurnId?`, `processUpdatedAt?`), and `this.shadowRootRef` (open `ShadowRoot`).
- `this.runtime` (`LeafOutcomeRendererRuntime`): `markdown.render(md)`, `server.resolveUrl(path)`, `server.fetch(path, init?)`, and `formatRelativeTime(iso)`.
- `this.canRender()` checks that the element is connected and `this.runtime` is set.
- `this.emitReady()` signals initial render completion; `this.emitError(code, message)` reports a renderer failure to the host slot.
- `escapeLeafOutcomeHtml(value)` and `normalizeLeafOutcomeOptionalText(value)` sanitize plain text.

The browser lazy-loads the custom element module when its Chronicle slot renders. Render within the host slot's width and honor shared accessibility requirements ([UI contracts](../maintainers/ui-contracts.md)). See [showcase-processes](../../extensions/showcase-processes/README.md) for a working custom element and build setup.

## Browser UI extension modules

Modules listed in `browserModules` export a default `BrowserUiExtensionModule` with `setup(api, context)`:

```ts
import type { BrowserUiExtensionModule } from "@leitwerk-dev/process-sdk";

const extension: BrowserUiExtensionModule = {
  setup(api, context) {
    const offFrame = api.onWsFrame((frame) => {
      // Inspect browser WebSocket frames; return true if handled.
      return false;
    });
    api.registerShellIndicator({
      id: "acme-status",
      label: "Acme status",
      mount(host) {
        host.textContent = "Ready";
        return () => offFrame();
      },
    });
  },
};

export default extension;
```

`BrowserUiExtensionAPI` provides three bounded hooks (each returns a cleanup disposer):

- `registerShortcut({ id, keys, label, handle(event) })` — registers a keyboard shortcut.
- `registerShellIndicator({ id, label, mount(host) })` — mounts a compact indicator inside the shell header; return an optional unmount callback.
- `onWsFrame(handler)` — observes incoming browser `WsFrame` messages.

`context` provides `extensionManifestId`, `moduleUrl`, and `resolveAssetUrl(relativePath)`.

## Browser bundle import boundaries

Browser modules run directly in the user's browser without a Node module loader. `npm run check:boundaries` enforces two strict rules on `src/ui/` and built `dist/ui/*.js` bundles:

1. **Allowed runtime bare specifiers:** Only `@leitwerk-dev/process-sdk/leaf-outcome-renderer` is permitted as a bare runtime import in extension UI source and built bundles. All other runtime imports must be relative (`./`, `../`) or browser-resolvable URLs (type-only `import type` imports are allowed).
2. **Workspace confinement:** Extension UI source files must not import runtime source files outside their own extension workspace.

Bundle any helper code into your emitted `.js` files so no unresolved bare specifiers leak into `dist/ui/`.
