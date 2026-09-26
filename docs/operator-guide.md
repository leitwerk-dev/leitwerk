# Operate a process

A process records one workflow from launch through completion or abort. Its steps
are called **turns**. A turn may use an AI model, run deterministic code, wait for a
person, or wait for an external event.

## Launch work

Choose a launcher on the home page. Its form defines the inputs for that process.
Select an available model profile and any offered skills, then submit.

An immediate launch shows a startup checklist. The browser opens the process when
it has been created; worker startup can still be in progress. Saving a scheduled
launch does not start a worker or create a startup checklist. You can inspect
scheduled work through the sidebar.

A pre-creation failure creates no process. A failure after creation retains the
process and its startup history. Recover that process rather than submitting a
second copy of the same work.

## Read progress

- The **Chronicle** shows recorded turns, live output, results, decisions, and failures.
- The **Turn Rail** navigates that history and shows the current turn and declared next turn.
- **Turn details** shows recorded input and execution metadata.
- **Show reasoning** opens the server-recorded activity for that turn. Missing activity
  is not evidence that an operation succeeded or failed.

Browsing history does not change the active turn. Repeated completed cycles and
older failed attempts may be collapsed; expand them to inspect earlier work.
Progress checklists are reports, not proof that a linked resource was created by
that attempt.

## Inspect an execution

Choose **Turn details** to open Trace, Context and Configuration. **Show reasoning**
and prompt links open the corresponding recorded content in Trace. The header keeps
the exact execution and its context origin visible while you read.

In Context, **Open exact source boundary** shows where inherited conversation ended.
The marked boundary separates inherited content from later source activity. Follow
source links to investigate ancestry; Back retraces your choices. Supplied products
show the version this execution received, even if a newer version was published later.

Configuration shows instructions, model and tools retained at each model call. Expand
and copy recorded content as needed. “Not recorded” means that evidence was not
retained; current workflow settings cannot reconstruct it. “Redacted” identifies
removed sensitive values. Human, automatic and external work do not have model input.

**Inspect process** opens the run overview, current workflow, launch inputs and context
map. Selecting a workflow step exposes its current contracts and links to matching
Chronicle executions. The context map also has a list for keyboard navigation.

**Show in chronicle** returns to the selected execution. Your action drafts remain
intact. Trace does not follow new output until you choose **Follow live**; scrolling
upward stops following. Answer questions and perform recovery actions in the Chronicle.

## Review and guide

When a process requests a decision, inspect its result and use the offered action.
Actions and forms belong to the process definition; not every process has the same
approval or revision loop.

An agent can ask structured questions during an LLM turn. Answer them in the
Chronicle. Answering resumes that turn; it does not start another attempt.
Instructions submitted during execution are queued in order. They do not rewrite
already recorded output.

Changing the selected model affects future LLM calls, not the call already in flight.
Model choices may be restricted by the process configuration.

A process waiting for an external event shows what it is listening for. Expand its
listening details to inspect observations or failed checks. No observation means
“not yet observed,” not “the external operation failed.”

## Recover failed work

A failure does not move the process to another business turn. The failed attempt
and any saved output remain available.

| Action | Use it when | Effect |
| --- | --- | --- |
| **Retry** | You want to run the failed turn again after correcting its cause. | Starts a new attempt. LLM preparation runs again. |
| **Continue** | Saved LLM progress is usable and you want to resume from it. | Resumes from the saved leaf with the offered instructions; reuses saved preparation when available. |
| Startup recovery | The worker failed before accepting the turn. | Prepares another worker start. It does not count as an executed turn attempt. |

Continue is offered only when retained progress supports it. Review error details
before choosing a different model or repeating work that may have changed an
external system. Cancellation cannot undo an external write already committed by
that system.

If startup says **Waiting for worker capacity**, it is queued, not failed. It starts
when capacity becomes available; queue time does not consume the startup timeout.

## Stop or delete

Stopping the active turn interrupts execution; aborting the process ends the
workflow. Use the confirmation text to distinguish these operations. Neither
operation reverses committed changes in connected systems.

Deleting a process also removes its managed workspaces, retained session trees,
result images, and process storage. Copy required results or arrange a backup
before deletion. Retention may also remove process storage after the configured
period. See [Backup and upgrades](operations.md).

## Create an issue from a result

When a ticket adapter is available, **Create issue** starts a separate draft process
from the selected durable result. Opening the dialog does not publish a ticket.
The draft process refines the request and asks for approval before the external write.
Check both the proposed content and destination. Stopping the parent does not stop
the derived process.

## Transfer a session to local Pi

For a process with a primary Pi session, choose **More actions → Create local transfer
link**. The link expires after one hour. Anyone holding it can download the retained
workspace and conversation; treat it as a secret.

Creating the link does not read or export the workspace. Export begins when local
Pi claims it. Accepted work and automatic successor turns finish first. During the
reserved export interval, manual process mutations are blocked.

The process shows transfer progress and permits cancellation before streaming
finishes. Delivered bytes cannot be recalled. After import, future local work uses
local Pi's configuration and credentials; it is not part of the server process.
See [workspace transfer](process-workspace.md#5-local-pi-session-transfer) for retained
files and format limits.

## Connect an HTTP client

Open **API tokens** in the account menu. Copy a new token before leaving the page;
its secret is shown only once. A token has its owner's application access, not a
separate set of process permissions. Logging out does not revoke it.

See the [API token reference](api-tokens.md) for requests, expiry, and rotation.
