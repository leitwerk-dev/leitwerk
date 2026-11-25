# Trace your first retry

In this tutorial you’ll make a planning step fail, retry it, and follow the result back to the code. The sandbox runs the Leitwerk server, browser UI, and worker on your machine. A script supplies the model responses, so you can repeat the exercise without a provider account.

## Start the sandbox

From a Leitwerk checkout on macOS or Linux with Git, Node.js 26 and npm, run the following commands. Leave the server running in this terminal.

```sh
npm ci
npm run dev:sandbox
```

Open the [local sandbox controls](http://127.0.0.1:18082/__local). Select **failure** and click **Start fresh scenario**. Follow the process link that appears below the controls. It opens the same process view a user would see.

## Recover the plan

1. Wait for the process to show **Error**. In its timeline (the **Chronicle**), read the failure message on the planning step.
2. Choose **Retry failed turn**. Stay on that process page. The new attempt produces a plan to update `notes.txt` and the process waits for review.
3. Reload the page. Find the plan and expand the earlier attempt in the Chronicle. Both belong to the same process. You can stop the sandbox with `Ctrl+C`.

## Find the boundary in code

Open `sandbox/scenarios.ts` and find the message you saw on the failed step. The scenario throws on its first call. On the next call it returns the plan. The server keeps the record of both attempts.

When does an attempt count? From the repository root, run this focused test.

```sh
npx vitest run packages/server/src/process-engine/engine-retry.test.ts -t "restarts an unaccepted automatic turn without consuming an attempt"
```

Open the test and find the assertion on `turnRecords.listByInstance`. It expects an empty list. Here the worker failed during startup. In the sandbox, the worker had already accepted the planning step before it failed, which is why the Chronicle kept a failed attempt.

Follow a start from reservation to acceptance in the [server and worker lifecycle](server-worker-lifecycle.md#start-acceptance-and-recovery). To choose where a core change belongs, use the [architecture guide](architecture.md) and the [validation matrix](testing.md#validation-matrix).
