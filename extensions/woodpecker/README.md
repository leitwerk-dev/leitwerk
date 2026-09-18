# Woodpecker integration

Server-owned Woodpecker profiles, pipeline external sources, bounded log access, and workflow-focused LLM tools. Tokens never enter workers.

```yaml
extensions:
  woodpecker:
    profiles:
      primary:
        base_url: https://ci.example.test
        token: "..."
```

The extension targets the Woodpecker 3 API. Tools resolve the current process
repository, list or inspect pipelines, decode and bound step logs, and explicitly
restart a diagnosed pipeline. The external source waits indefinitely until the
newest repository/SHA/event match is terminal. Push pipelines must also match
the configured source branch. Woodpecker reports the target branch for pull
request pipelines, so pull request events match by source-head SHA instead.

## Explicit integration composition

`WoodpeckerClientLike` and `setupWoodpeckerIntegration` support alternate clients
with the same tool registration, durable writes and correlated pipeline polling.
An optional clock permits deterministic local polling.

## Project binding

Server launch code writes a non-secret `metadata.woodpecker` object containing
`{ owner, repo, profile }` on each process project. Tools use only the project
selected and authorized by the server, never repository/profile tool arguments.
`WoodpeckerProjectBinding` and `resolveWoodpeckerProjectBinding` expose this contract.
Different projects in one process may use different profiles. Credentials remain
in the server integration; bindings contain only a profile identifier.

When `metadata.woodpecker` is absent, the compatibility reader uses the old
`metadata.forgejo` repository and `woodpeckerProfile` process parameter.
An explicit Woodpecker binding must contain all three fields.
Malformed explicit values fail instead of selecting another profile.
Capability, watcher, external-source and write identifiers retain their original
strings, including historical `@leitwerk-private/` prefixes. Package names do not
rename durable protocol identities.

## Local adapter

Import `LocalWoodpeckerAdapter` from `@leitwerk-dev/woodpecker/testing` and supply its
`client()` through `setupWoodpeckerIntegration`. Construct the adapter with an owned
`root` directory, a local `baseUrl`, and an optional `now` clock. Provider state
persists in `woodpecker.json`; unknown resources fail locally. Production registration
does not import this entrypoint. The adapter never falls back to HTTP.

`seed(fullName)` registers a CI repository without a Git-host dependency.
`publish(repository, { branch, commit, event, status, logs })` supplies correlated
pipeline results. Local Git compositions resolve the actual commit before calling it.

## Pipeline lookup window

`listPipelines(repoId, signal?, { page, perPage })` defaults to page 1 with 100
pipelines. Correlated polling searches up to 10 pages (1,000 newest pipelines),
stopping at the newest match, exhausted history, or `afterPipelineNumber`.
A newest pending match continues waiting even if an older match is terminal.
An inconclusive scan reports a lookup-window error; inspect repository history
and adjust the watched pipeline floor before retrying. No match within exhausted
history is an ordinary wait for a future pipeline.

## API support

The following exported declarations are `@public`:

- `@leitwerk-dev/woodpecker`: `WoodpeckerClient`, `WoodpeckerClientLike`, `WoodpeckerIntegration`, `WoodpeckerPipeline`, `WoodpeckerProjectBinding`, `WoodpeckerRepository`, `default`, `setupWoodpeckerIntegration`.
- `@leitwerk-dev/woodpecker/testing`: `LocalWoodpeckerAdapter`, `LocalWoodpeckerOptions`, `LocalWoodpeckerRepository`, `LocalWoodpeckerState`.

Members have individual classifications; these exports do not make every member
public. Both `@public` and `@internal` APIs remain usable and fully typed. Source
annotations are authoritative; see the [SDK compatibility
policy](../../docs/process-sdk.md#api-compatibility).

### External-write replay

Pipeline restart uses `ctx.externalWrites.logOnly()` and returns `{ ok: true }`.
The durable record includes diagnosis metadata and prevents a recorded restart
from repeating. Lost responses and remote success followed by recording failure
cannot be recovered. Pipeline status is not evidence that a restart occurred.
