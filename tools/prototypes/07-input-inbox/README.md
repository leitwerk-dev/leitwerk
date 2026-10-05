# Steering input inbox

Throwaway prototype, idea 07. All data is synthetic and held in memory.

## Question

Can an operator distinguish queued guidance, acknowledged worker consumption, and
actual inclusion in a model call when a delivery acknowledgement goes missing?

The proposed inbox keeps durable FIFO sequence visible and separates server state
from a surviving worker's state. It gives the operator evidence about where an
instruction is waiting without suggesting that an in-flight model call can change.

## Run

Open `index.html` directly in a browser. No install or server is needed. Reload or
**Reset demo** discards the simulation. The initial fixture is a running model
call with no steering inputs.

Edit an instruction draft and queue it. Its text and sequence become fixed.
**Deliver / replay pending** sends server-pending records to the worker.
**Consume next input** applies the next FIFO instruction and normally acknowledges
it. **Lose next acknowledgement** drops the next consumption acknowledgement.
**Reconnect & reconcile** uses the same worker's consumed-sequence watermark to
repair server state, then delivers remaining inputs. **Finish current call** and
**Capture next call** expose the context boundary explicitly.

The pure `initialState` / `reduce` functions are separate from the DOM shell.
Every transition returns a cloned state. The shell renders server records, worker
queue, consumed watermark, replay count, acknowledgement fault state, applied
instruction count and fixed model-call snapshots. All displayed counts come from
that state. Simulated ticks stand in for timestamps internally.

## Walkthroughs

1. **Ordered steering:** queue two instructions, deliver the batch, consume each,
   finish call 1 and capture call 2. Call 2 contains sequences `1, 2`; call 1
   remains unchanged.
2. **Lost acknowledgement:** queue and deliver, arm the fault, consume, replay and
   reconcile. The server remains pending after consumption, replay applies
   nothing again, and the surviving worker's watermark repairs the acknowledgement.
3. **Too late for this call:** acknowledge guidance after call 1 started. Trying
   to capture another call is rejected until call 1 finishes. Guidance first
   appears in call 2.

Scenarios reset to a known state and enable one step at a time. Free-play actions
leave the walkthrough. Arrow keys, Home and End switch scenario tabs.

## Existing integration seams

- `packages/domain/src/domain-model.ts`: `ProcessInput` owns `id`, `sequence`,
  source, kind, target, body, actor, received time and consumed time. This
  experiment uses untargeted operator instructions only.
- `packages/server/src/process-input-dispatch.ts`: `persistQueuedProcessInputs`
  assigns increasing sequences; `dispatchProcessInputs` delivers to an existing
  worker or requests one; `toInputDelivery` builds the IPC payload.
- `packages/server/src/db/process-input-repo.ts`: `listUnconsumed` selects pending
  inputs in ascending sequence order; `markConsumed` records consumption.
- `packages/worker/src/input-consumer.ts`: `deliverBatch` calls Pi `prompt` or
  `steer` in order. The prototype represents successful consumption as a manual
  action, without modeling Pi's internal scheduling.
- `packages/worker/src/runtime/lifecycle-reducer.ts`: incoming `input.batch`
  filters sequences at or below `lastSequenceConsumed`; `enqueueInputs` combines
  pending deliveries; `inputs_delivered` advances consumption and emits
  `worker.input_consumed`.
- `packages/server/src/supervisor/worker-input-ack-handler.ts`: records
  consumption and broadcasts `process.input.acknowledged`.
- `packages/server/src/supervisor/adoption/worker-adoption-coordinator.ts`:
  adoption heartbeat reconciliation marks inputs through the surviving worker's
  consumed watermark and sends the rest. The demo's reconnect button compresses
  this specific adoption path into one action.
- `packages/server/src/process-ui-snapshot-presenter.ts`:
  `buildTimelineInputSummary` already exposes sequence, body and consumed time.
  An inbox can be a presentation of these facts.
- `packages/worker/src/pi-inspection.ts`: captures `model_input` at the provider
  call boundary, including message content and entry links when unambiguous.
  Those captures are a potential source of evidence for the proposed call view.

Visual context comes from `packages/ui/PRODUCT.md` and `packages/ui/DESIGN.md`.
No application code, shared contract, dependency or runtime configuration changes.

## Validation performed

- Extracted inline JavaScript and ran `node --check`: passed.
- Targeted repository Biome check: passed.
- `git diff --check`: passed.
- Real Chromium interactions using the isolated `idea-07` agent-browser session:
  all three walkthroughs completed. Ordered steering produced applied `[1, 2]`,
  zero pending acknowledgements, call 1 `[]`, call 2 `[1, 2]`.
- Lost acknowledgement left server-pending `[1]`, worker watermark `1`, applied
  `[1]`, empty worker queue. Replay incremented skipped deliveries to `1` without
  another application; reconciliation cleared server pending.
- Capturing while call 1 was active produced the explicit rejection. Finishing it
  and capturing call 2 produced `[]` then `[1]` in the two fixed captures.
- Free-play queued edited drafts, lost an acknowledgement and retained separate
  acknowledged, consumed-but-pending and server-queued rows.
- Captured and visually reviewed `screenshots/desktop.png` at 1360px and
  `screenshots/mobile.png` at 390px. No horizontal overflow at either width.

Scoped standalone validation follows AGENTS.md section 7. Application full
validation was not run; this artifact does not affect application execution.

## Limits and provisional learning

The experiment supports showing acknowledgement and model-call inclusion as
separate facts. Pending acknowledgement must not invite an operator to send the
same instruction again. Reconnect can explain reconciliation rather than silently
making a pending row disappear.

The simulator knows that an acknowledgement was intentionally lost. Production
UI cannot infer that from a pending record alone: it must show uncertainty until
worker evidence or reconciliation is available. “At worker” status and exact
input-to-call attribution are proposed evidence views, not existing API guarantees.
The current call captures can lack unambiguous entry links, so a production view
needs an explicit unknown state instead of text matching to guess attribution.

Replay idempotence here is limited to one surviving worker with its watermark.
The prototype does not claim exactly-once delivery across worker replacement,
partial Pi delivery failure, crashes or lost durable state. It omits targeted
inputs, concurrent writers, lease identity, process lifecycle permissions and
adoption transport details. Every simulated call retains all previously applied
instructions; real Pi context retention and compaction may differ. “Captured”
means present in supplied context, not understood or followed by a model.

No reordering, withdrawal, editing of queued records or production integration is
proposed by this artifact. The UI remains a future proposal for review.
