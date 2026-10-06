# Who is handling this?

A throwaway operator prototype for advisory presence and time-bounded work claims.
Open `index.html` directly in a modern browser. It has no dependencies, server,
network calls, persistence, or production integration. Reloading or **Reset free
play** clears the synthetic fixture and both operators’ drafts.

## Question

Can lightweight advisory presence prevent duplicated human effort without making
a stalled browser block urgent work?

Two operators can read the same question and prepare contradictory answers. A
small inline coordination strip distinguishes **Viewing**, **Handling**, and
**Submitted**. A handling claim expires; it never reserves a business turn or
grants permission to answer. This is coordination during a live intervention,
not shift transfer, authorization, assignment, or an attention digest. That is
its distinction from the earlier prototype batch.

## Try it

The main surface is one synthetic question inside the active **Prepare release**
turn. The simulator changes fixture state; the answer form simulates submitting
actual guidance. Claim and status changes leave the selected turn, lifecycle,
and attempt alone. An accepted answer resumes the same turn.

- Claim, renew, or release handling. Claims last five simulated minutes.
- Share a short coordination status while handling. This never sends agent input.
- Type independent answer and status drafts for Nora and Sam. Switching browsers,
  claim updates, expiry, release, and refused actions retain those drafts.
- Put a browser to sleep, advance six minutes, take over an expired claim, and
  resume the original browser. Its coordination snapshot stays labelled stale
  while asleep; return shows a warning when coordination changed.
- Send an answer while a colleague is handling. Claim ownership is deliberately
  absent from decision validation. Sending checks the current question, refuses
  a question already answered, and keeps the unsent draft available to copy.
- Try anonymous mode. Named presence and claims are unavailable because separate
  people cannot be established. Answering remains available with anonymous attribution.

The pure `Model` module owns the reducer and synthetic clock. The DOM layer only
projects state and dispatches actions. No automatic clock or heartbeat runs.
**Advance 6 minutes** deliberately ages presence as well as claims. Only the
simulator’s explicit actions change time. The five-minute expiry is illustrative,
not a proposed production default.

## Walkthroughs

Each scenario starts from the same fixture. Use its next-step button; it advances
only when the expected outcome is observed. Free-play controls remain usable.

1. **Work together:** Nora claims the question, shares a migration-guide status,
   and sends an answer. Sharing status keeps the question open; submitting clears
   handling and records the accepted answer.
2. **A browser falls asleep:** Nora drafts and claims, sleeps, and misses expiry.
   Sam takes over. Nora resumes with her draft and a coordination-change warning.
   Trying to replace Sam’s live claim is refused. Review the current coordination
   to clear the warning. The question remains open throughout.
3. **Someone answers first:** Nora claims and drafts. Sam submits despite Nora’s
   advisory claim. Nora’s later submission is refused because the question is
   already answered, and her draft remains intact.

## Integration seams

These files were inspected at base `050a860b016a00db2eab6ceec31bf21885a6165f`.
The prototype does not alter or call them.

| Existing seam | Relationship to a future implementation |
| --- | --- |
| `packages/domain/src/domain-model.ts` — `Actor`, `ADMIN_ACTOR` | Use attributed identities when available. The shared unauthenticated actor cannot distinguish people. |
| `packages/ui/src/chronicle/components/ChronicleQuestionRequest.svelte` | Attach the coordination strip to the canonical question form, preserving its independent draft. |
| `packages/ui/src/pages/process-detail/ProcessDetailChronicle.svelte` | Keep the question and its result in the process Chronicle. |
| `packages/server/src/routes/process-questions.ts` | Existing answer endpoint delegates to the question service and returns a conflict for `not_current`. |
| `packages/server/src/process-question-service.ts` — `submitAnswers` | Validates that the request is open/current under exclusive process coordination, then records the answer. |
| `packages/server/src/process-operation-coordinator.ts` | Remains the authority for business mutation serialization. An advisory claim does not replace it. |
| `packages/server/src/routes/process-actions.ts` | Process-defined actions likewise retain existing mutation validation and actor attribution. |
| `packages/server/src/server-bootstrap/register-websocket.ts`, `packages/server/src/ws/broadcast.ts` | Existing authenticated browser transport and ephemeral frames are possible delivery seams for proposed coordination updates. |

## Proposed additions

A future short-lived server registry would key presence and claims by process
and exact decision/request identity. A claim needs the actor, browser/session,
server expiry, status text, and a version for atomic renewal, release, and takeover.
It must reject an old browser’s attempt to renew a superseded claim while allowing
normal business submissions by every operator who already has application access.

Ephemeral snapshot/update messages would carry a sequence and server time. A
resumed browser must reconcile its old claim with current coordination before
presenting it as current. Explicit coordination review only clears a local warning;
it does not answer, approve, or change the process. Closure of the underlying
question clears its claim.

Claim availability must be independent of question/action route availability.
Anonymous mode should omit named claims rather than invent distinct actors. Any
future durable coordination notes would need an explicit schema migration; this
experiment keeps all notes in memory and outside process inputs. No permission,
tenant-isolation, or business-lock contract is added here.

## Observed validation

- All three guided scenarios completed with real browser clicks and assertions
  against visible outcomes, including live-claim refusal and already-answered
  refusal. The expiry case retained Nora’s draft and displayed the resumed warning.
- Free play used typed drafts: rejected status sharing retained its draft; another
  operator’s refused claim, operator switching, release, and answer submission
  retained the answer draft. Status sharing left the question open.
- Anonymous mode refused claims while accepting an answer with anonymous attribution.
- Desktop at 1440px and mobile at 390px were captured and visually inspected.
  At 390px the document width was 390px; every button was at least 44px high.
  The isolated browser reported no page errors.
- Biome HTML check, extracted inline JavaScript `node --check`, and
  `git diff --check` passed. No application validation was run: this is an isolated
  standalone prototype under the scoped-validation policy.
- The Impeccable detector ran once with no reported findings, but was in degraded
  regex mode because its HTML parser modules were unavailable. Selector-aware
  checks, custom-property resolution, and computed contrast were not evaluated.

Screenshots show Nora returning after Sam takes over her expired claim:
[desktop](screenshots/desktop.png) and [mobile](screenshots/mobile.png).

## Limits and provisional learning

This is one in-memory process, two simulated browsers, one question, and a manual
clock. It does not prove transport reliability, actual concurrency, authentication,
server restart behavior, or usability with real operators. The simulator exposes
actual process state even while one browser’s coordination snapshot is stale.
The question’s synthetic revision check is illustrative; no new production
request shape is claimed. Drafts do not survive page reloads.

The model supports the intended separation: explicit handling communicates intent,
expiry makes recovery possible, and authoritative decision validation prevents a
second accepted answer. The most useful signal is the resumed-browser warning
beside the retained draft. Whether operators understand advisory claims quickly,
and whether a five-minute illustrative window is appropriate, still needs user
observation.
