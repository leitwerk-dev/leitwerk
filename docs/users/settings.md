# Settings

Use **Settings** in the sidebar to change shared defaults, such as which AI model a repository uses. Changes affect other people using the same installation.

## Edit or reset settings

1. Open **Instance** to change a default for the whole installation. To customize a repository, open **Repositories**, find it by name, and select its row. Other tabs may be available for groups such as issue-tracker projects.
2. Check the **Effective value** to see what Leitwerk uses now and where it comes from.
3. Choose **Override** or **Edit override**, enter the new value, then choose **Save override**.
4. To remove a customization, choose **Use inherited value**. A repository without its own value uses the broader setting.

If you cannot find a recently connected repository or project, choose **Refresh sources**. If someone saves the same setting while you're editing, compare your draft with the saved value before choosing **Keep draft and use latest revision** and saving again.

## Settings on a process

On the process page, open **Inspect process**, select **Inputs & configuration**, and find **Scoped settings**.

- Use **Defaults for future steps** to see which defaults new steps will use.
- Use **Captured settings** to see which values a step kept when Leitwerk prepared it. A change in **Settings** takes effect the next time a step is prepared, including on retry.
- If the process uses several repositories, choose a **Primary repository for model defaults**, or select **Use Instance settings**. Click **Save primary repository** to apply your choice.

To pick a model for a single run or step, [change the model for a process](operate-processes.md#change-the-model-for-a-process).
