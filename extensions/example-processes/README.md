# Example processes extension

This extension provides Single Prompt, Single Prompt + Done Tool, Single Prompt + External Complete, and the three Kubernetes smoke processes. Poem Creator lives in [showcase-processes](../showcase-processes/README.md). Either extension can be loaded independently.

## Load

```yaml
extension_loading:
  sources:
    - ./extensions/example-processes

extensions:
  example-processes:
    file_triggers:
      complete_prompt_path: /tmp/complete-prompt
```

When upgrading from the combined showcase extension, add this source and move `file_triggers.complete_prompt_path` to the configuration above. Existing process, launcher, renderer, and external-source ids are retained. The renderer and external-source ids still use the `@leitwerk-dev/showcase-processes` prefix so persisted outcomes and armed completion files continue to resolve.

## Completion

Single Prompt completes when the assistant turn ends. Single Prompt + Done Tool requires the `done` outcome tool. Single Prompt + External Complete waits after the prompt until its configured completion file exists, then consumes the file after successful admission. A failed admission retains the file for a later poll.

Selected external sources carry their own poll interval. `file_triggers.poll_interval` remains a compatibility key.

The Kubernetes smoke processes exercise a deterministic worker step, specialized worker-image selection, and worker adoption across server restarts. Load this extension in the server and worker configuration used by the smoke scripts.

## Browser assets

The source lane loads `src/ui/manifest.json`; the dist lane loads the manifest and bundles under `dist/ui`. Run `npm run build:ext-ui` to build the browser assets.

## API support

The default export from `@leitwerk-dev/example-processes` is `@public`. See the [SDK compatibility policy](../../docs/process-sdk.md#api-compatibility).
