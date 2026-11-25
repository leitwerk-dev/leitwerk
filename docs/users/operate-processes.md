# Operate processes

## What to do when a process pauses

Open the process and look at the latest entry in the Chronicle. If you're looking for a run that needs you, use **Needs attention** in **All processes**.

| What you see | What to do |
| --- | --- |
| **Waiting for your answers** | Answer each question using the options or **Write another answer**, then click **Send answers**. The same turn resumes. |
| **Action required** or **Decide what happens next** | Read the preceding result and [choose one of the offered actions](#choose-an-action). |
| **Review issue** | Review the destination and draft before you [publish it, request changes, or discard it](#review-issue-drafts). |
| **Waiting to continue** or **Waiting for a condition** | Read the condition and check **Next check** to see when Leitwerk will check again. |
| **Waiting for an event** | Expand the card to see which event Leitwerk is listening for and whether it has been received. |
| **Error** | Read the failure message and use the [recovery options](#recover-from-an-error) offered on the process page. |

## Find a run and read its progress

1. Open **All processes** and search by title or a phrase from the original prompt. Use **Process type** or **Status** to narrow the results.
2. Open a result. The header shows the run's current status. Read the Chronicle for results and any decision that needs you.
3. To revisit an earlier turn, choose it in the step list beside the Chronicle. On mobile, open **Quick nav**. For longer histories, **Load earlier steps** retrieves older entries.

### Check how a turn produced a result

1. Find the turn in the Chronicle. If only a summary is visible, choose **Read full result** or **Expand result**.
2. Open **Turn details** and choose **Trace** to see recorded messages, tool calls, and output.
3. Choose **Context** to see what the turn received. **Inherited conversation** shows where its history came from. **Supplied products** shows the exact version of any earlier output passed to the turn. **Model inputs**, when available, shows what the model received for each call.
4. Choose **Show in chronicle** to jump back to that turn, or **Return to process** to close the inspector.

For the original request and launch settings, open **Inspect process** and choose **Inputs & configuration**. You can browse earlier turns and inspect their details while the current turn runs. To interrupt it, use [Stop turn](#stop-restart-or-delete-a-process) in the Chronicle.

## Choose an action

1. Read the preceding result and select the action you want. The available actions depend on the workflow.
2. If a form opens, fill in the requested details. When **Next-turn model** is available, you can choose the model for the step this action starts.
3. Submit the form to run the action. To delay an action that offers **When to run**, choose **Run later**, set **Run at**, and click **Schedule action**. Use **Edit** or **Cancel** on the **Scheduled action** card if plans change.

## Review issue drafts

When the Chronicle shows **Review issue**, check where the issue will be filed and expand **All issue fields** to see the details.

- Choose **Create issue** to approve publication.
- Choose **Request changes**, describe what to revise, and click **Send changes**.
- Choose **Discard draft** to end the review without publishing.

### Create an issue from a result

If your installation has ticket creation enabled, use **Create issue** on a completed result. To use a particular passage, select the text in the result and click the **Create issue** button that appears. Describe the issue and choose **Draft issue**. This starts a separate process that asks for your approval before publishing.

## Launch or schedule a process

1. Open **Start a process** and choose the workflow you want. Fill in the requested inputs and add a title if it will help you find the run later. If the form offers **Skills**, you can [choose instructions for this run](skills.md#use-a-skill-on-a-new-run).
2. Review any warnings before submitting. **Configuration required** and **Some selections need configuration** mean you need to fix the listed issues or change your selection.
3. Under **When to run**, choose when the work should begin.

   - **Start now** runs the process when you submit the form. The submit button is named for the workflow, such as **Run Prompt**.
   - **Start later** schedules a single run. Set **Start at** in your local time and click **Schedule process**.
   - **Run on cron** repeats a run. Choose an example or enter a five-field cron expression in UTC, check the previewed **Next run**, and click **Save cron schedule**.

For a walkthrough of an immediate run, see [Run your first process](index.md#run-your-first-process).

### Manage scheduled launches

Open the schedule from **Future** in the sidebar or filter **All processes** by **Scheduled**. Choose **Edit** to change the inputs, model, or time, then click **Save schedule**. Use **Cancel scheduled launch** to remove the schedule.

If the schedule is marked **Blocked**, read the reason on the schedule page and fix it before the run can start.

## Check why an event hasn't started a process

1. Open **Watchers** from the sidebar and find the watcher that should start the workflow. Check whether it shows **Enabled**.
2. Compare the event with **Listens for** and check **Starts** for the expected workflow.
3. Expand **Configuration details** to check settings such as **Launch model**. If the configuration needs to change, share the watcher's name and the mismatch with the person who manages Leitwerk.

## Change the model for a process

- Before submitting a launch, use **Model setup** to choose a **Default model**. To set a model for a particular step, choose **(edit)** under **Models Per Step**.
- For an ongoing process, open **Inspect process**, select **Inputs & configuration**, and choose **Edit models** under **Model defaults and overrides**. Choose the models and click **Save changes**. Your changes apply to future steps. An AI response already in progress continues with its current model.
- For a failed step, expand **Retry options** if offered and choose a model before continuing or retrying.

The **Dashboard** shows **Configuration issues** with links to the affected work or settings. To check spending, open **LLM costs** on the dashboard. The panel estimates costs from recorded turns and indicates when cost information is missing.

## Recover from an error

Open the failed turn in the Chronicle and read the error. If the turn was creating an issue or changing something in another system, check whether that change already happened before retrying.

- **Continue from saved work** resumes from the saved point when enough progress is available. You can edit **Message before continuing** to guide the resumed turn.
- **Retry failed turn** runs that step again from the beginning.
- **Retry startup** or **Choose model and retry startup** appears when the run fails before the turn starts. If you see **Waiting for worker capacity**, the process is already queued to start.

## Stop, restart, or delete a process

- To interrupt the current turn, click **Stop turn** and confirm. You can continue from saved work or retry from the Chronicle when those options are available.
- To end the entire run and keep its history, choose **More actions**, then **Abort process**.
- To launch a separate run with the same inputs, choose **Retry as new process**. Review the prefilled form before submitting. To end the current run first, use **Abort and retry as new process** when available.
- To permanently remove a run, choose **Delete process**. This also removes its history, managed workspace, and saved results.

On a process with a saved Pi session, **More actions** also offers **Download Pi session (.jsonl)** and **Create local transfer link**. Use the transfer link to move the workspace and conversation to a local Pi session. Keep the single-use link private. It expires after one hour.

Press `?` to see keyboard shortcuts for the current page.
