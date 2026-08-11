# Showcase processes extension

This extension provides demo and smoke-test processes:

- Poem Creator;
- Single Prompt;
- Single Prompt with Tool;
- external-completion examples;
- Kubernetes smoke processes.

It also provides a filesystem external-source provider and selected-leaf renderer assets.

## Load

```yaml
extension_loading:
  sources:
    - ./extensions/showcase-processes

extensions:
  showcase-processes:
    file_triggers:
      poem_review_path: /tmp/poem-review-{instanceId}
      complete_prompt_path: /tmp/complete-prompt
```

`{instanceId}` prevents concurrent poem processes from sharing one review file.

`file_triggers.poll_interval` is a compatibility key. Selected external actions carry their own poll interval.

## Poem watcher

The example config registers `poem_creator_process.create_poem` as a filesystem process watcher:

```yaml
process_configs:
  poem_creator_process:
    watchers:
      create_poem:
        enabled: true
        poll_interval: 1s
        file_path: /tmp/create-poem
```

Writing a non-empty prompt to the file creates a poem process. The watcher consumes the file after process creation commits.

## Poem review loop

Poem drafts and human-requested revisions continue on one full-context primary branch, so each revision inherits the current poem instead of starting a replacement from fresh context. The automated reviewer forks from the latest primary poem. Later requests to change that review continue on the review branch while the primary poem leaf remains unchanged.

When the automated reviewer leaves feedback, the operator can:

- accept the review, restore the primary poem branch, and send the feedback as its next revision request;
- request review changes and continue on the review branch;
- dismiss the review and return to the primary poem decision without applying the feedback.

Dismissing feedback clears the active review result and branch reference. The existing poem remains available for completion, revision, or another automated review.

## External completion files

The file provider polls armed file sources. It maps the process definition's default paths to configured aliases, reads non-empty content, fires the matching `{ instanceId, armingId }`, and consumes the file according to the source declaration.

## Browser assets

The source lane loads `src/ui/manifest.json` and lets Vite transform the custom-element sources directly. The dist build publishes the import manifest and bundles under `dist/ui`; run `npm run build:ext-ui` when validating those production assets. Both lanes expose the modules through `/ext-ui/...`.
