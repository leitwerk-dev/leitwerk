# Testing extensions

`@leitwerk-dev/test-support` provides two harnesses for testing extensions without constructing internal SDK contexts or importing server internals. Keep extension-specific prompt, state, and adapter tests inside the owning extension package.

For core repository validation gates, Vitest projects, and Playwright browser tests, see [Testing](../maintainers/testing.md). Run `npm run check:boundaries` (or `leitwerk-dev test:full`) to verify package and extension UI bundle import boundaries.

## Check the first process launcher

After building the [first process](first-process.md), check what happens when someone submits a blank prompt. In the Leitwerk checkout, save this test alongside the extension’s `src/index.ts` as `launcher.test.ts`.

```ts
import { createExtensionTestHarness } from "@leitwerk-dev/test-support/process";
import { expect, it } from "vitest";
import extension, { firstProcess } from "./index.js";

it("asks for a prompt when the submitted field is blank", async () => {
  const harness = await createExtensionTestHarness({ extensions: [extension] });
  try {
    const process = harness.process(firstProcess, { params: { prompt: "Draft a response" } });
    const result = await process.resolveLaunch("first_process.start", { prompt: " " });
    expect(result).toMatchObject({ ok: false, errors: [{ fieldId: "prompt" }] });
  } finally {
    await harness.close();
  }
});
```

Run `npx vitest run extensions/first-process/src/launcher.test.ts` from the checkout root. The passing assertion verifies that the form identifies the field the user needs to fix. This check runs without a model or server.

## Choosing a harness

| Harness | Import | Use it for |
| --- | --- | --- |
| `createExtensionTestHarness` | `@leitwerk-dev/test-support/process` | Fast, persistence-free unit tests of process graphs, launchers, actions, outcomes, and integration tools. |
| `createExtensionIntegrationHarness` | `@leitwerk-dev/test-support/integration` | Durable end-to-end tests with real server/worker IPC, SQLite persistence, fake provider adapters, and scripted model responses. |

Use `FakeLlmProvider` for model boundaries, `@leitwerk-dev/test-support/fixtures` for independent business fixtures, and extension-owned fakes for external providers. Assert observable contracts rather than internal call sequences or incidental prompt wording.

## Process and handler tests

`createExtensionTestHarness({ extensions, extensionConfig?, capabilities? })` evaluates definitions and handlers from explicit fixtures without persistence across calls:

| Surface | Methods |
| --- | --- |
| `harness.process(def, fixture)` | `describe()`, `resolveLaunch(launcherId, input)`, `prepareRelaunch(launcherId, previousInput)`, `resolveWatcherLaunch(watcherId, event)`, `evaluateTurn(turnId, response?)`, `evaluateAction(actionId, input?)`, `evaluateOutcome(turnId, outcome, params?)` |
| `harness` (tools & events) | `callTool(name, args, fixture)`, `writeReceipts()`, `describeTools()`, `emit(event, payload)`, `listToolDestinations(name)`, `resolveToolDestination(name, destinationId)`, `validateToolDestination(name, snapshot)`, `close()` |

- Supply `params`, optional `state`, `projects`, `products`, and `workspaceRoot` in `fixture`.
- For integration tools, inspect returned values and `writeReceipts()` (including writes recorded before a subsequent failure). Reuse `invocationId` in the tool fixture to verify retry reconciliation.
- Pass provider bindings through project fixture metadata rather than hand-crafting execution contexts.
- Always `await harness.close()` in a `finally` block.

## Durable integration tests

`createExtensionIntegrationHarness(options)` boots a real server and worker lifecycle with your registered extensions, fake external adapters, and scripted model responses.

Key options:

- `models` / `defaultModel`: declare available fake model profiles and the default profile. **Note:** `config.process_configs` (including `watchers`) is populated only when `defaultModel` is set.
- `execution`: `"auto"` (default) or `"manual"` (step one selected turn at a time via `runTurn()`, including automatic turns, through real start acceptance and stale-outcome checks).
- `polling`: `"auto"` or `"manual"` (disables background timers while keeping extension lifecycle hooks so tests call the polling adapter explicitly).
- `watchers`, `extensionConfig`, `hostDocker`: configure watcher blocks, owner extension config, and Docker preflight boundary.

| Surface | Methods |
| --- | --- |
| `harness` | `launch(launcherId, input, modelConfig?)`, `createProcess(input)`, `seedAcceptedTurn(instanceId, fixture)`, `request(req)`, `restart({ whileStopped?, extensionConfig? })`, `close()` |
| Process handle | `snapshot()`, `action(actionId, input?)`, `retry(options?)`, `supplyInput(text)`, `answerQuestions(answers)`, `respondToApproval(decision)`, `runTurn()`, `waitFor(predicate, options?)` |

- Scripted model callbacks receive the rendered prompt, declared tools, working directory, inherited branch text, and opaque branch identity.
- `waitFor()` is bounded and reports the final observed snapshot on timeout.
- `restart()` preserves file-backed SQLite and process handles while letting `whileStopped` mutate external fixtures or `extensionConfig` update wiring.
- Use real execution (not `seedAcceptedTurn`) when verifying worker tree entries or Pi resource materialization.
- Always `await harness.close()` before removing caller-owned directories or fixtures.
