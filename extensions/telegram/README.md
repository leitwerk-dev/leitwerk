# Telegram extension

Server-side extension that exposes leitwerk processes through a Telegram bot.

## Phase 1 behavior

- One bot per leitwerk instance.
- One private Telegram supergroup with forum topics enabled.
- One forum topic per process; completed and aborted process topics are closed.
- Operators can create a new forum topic, see launch help from the bot, send `/launch`, fill out launcher fields in Telegram, and have that topic become the process topic.
- Condensed process feed: process creation, submitted action summaries, turn starts, turn outcome/leaf results, lifecycle changes, errors, and action prompts.
- User actions through inline buttons and short form prompts. Optional action form fields include a `Skip` button.
- Free-text messages in a process topic are queued to that process.
- Retry recovery controls appear only when the process has a failed turn record; Continue appears only for failed LLM turns with saved continuation recovery context. Close a process topic to abort its process.
- Reasoning details, raw Pi diagnostics, usage, and costs are intentionally hidden.

## Telegram setup

Do these steps in Telegram before enabling the leitwerk extension:

1. Open `@BotFather`, run `/newbot`, choose a name and username, and copy the bot token.
2. Keep the token private. Prefer `bot_token_env` for shared config; use `bot_token` only when you intentionally want the token in `leitwerk.yaml`.
3. Create a private group for leitwerk notifications. Telegram forum topics require a supergroup; enable **Topics** in the group settings so it becomes a forum-enabled supergroup.
4. Add the bot to the group.
5. Promote the bot to admin with permission to:
   - send messages,
   - create topics,
   - edit/manage topics.
6. Send a test message in the group after adding the bot. This makes the chat visible in Bot API updates while you collect the group chat id.
7. Get your Telegram user id and the group chat id before enabling the extension. The bot enforces the allowlist from startup and does not provide an unauthenticated ID-discovery command.

### Finding Telegram IDs

Common options:

- Send a direct message to a trusted Telegram ID helper bot (for example `@userinfobot`) to learn your numeric user id.
- To find the private supergroup chat id, temporarily add your leitwerk bot to the group, send a message in the group, then inspect Bot API updates while the leitwerk is not polling:

  ```sh
  curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
  ```

  Use the `message.chat.id` value for `delivery.forum_chat_id`; supergroup ids typically start with `-100`.

Remove any temporary helper bots after setup and keep the bot token private.

## Leitwerk setup

1. Add the extension path to `extension_loading.sources`.
2. Provide the bot token through either:
   - `bot_token_env`, with the token stored in an environment variable, for example:

     ```sh
     export TELEGRAM_BOT_TOKEN="123456:bot-token"
     ```

   - `bot_token`, with the token written directly in `leitwerk.yaml`.

3. Add your numeric Telegram user ids to `allow_user_ids`.
4. Set `delivery.forum_chat_id` to the private forum-enabled supergroup id.
5. Restart the leitwerk so the server extension loader starts the bot.
6. Create or launch a process; the bot should create a forum topic for that process.

If startup fails with an invalid Telegram config error, verify that the token is configured, the token environment variable is visible to the leitwerk process when using `bot_token_env`, the allowlist is non-empty, and the forum chat id is set.

## Configuration

Load this extension explicitly through `extension_loading.sources`, then configure it under `extensions.telegram`:

```yaml
extension_loading:
  sources:
    - ./extensions/telegram

extensions:
  telegram:
    enabled: true
    bot_token_env: TELEGRAM_BOT_TOKEN
    # bot_token: "123456:bot-token" # Optional inline YAML fallback when bot_token_env is unset.
    allow_user_ids:
      - 123456789
    delivery:
      forum_chat_id: "-1001234567890"
    markdown:
      max_chars: 3900
    topic_title_template: "{title} · {shortId}"
    # Optional: opt out of per-action model selection
    # action_model_selection:
    #   enabled: false
```

Prefer `bot_token_env` over a literal `bot_token` for shared config. If both are set, the environment variable value is used when present; otherwise the literal `bot_token` is used as a fallback.

## Commands

In an unmapped forum topic:

- `/launch` — choose from available launchers and start a launch wizard.
- `/launch <launcherId>` — start a known launcher directly.
- `/launchers` — list launcher ids and descriptions.
- `/cancel` — cancel the pending launch draft.
- `/help` — show launch help.

In a process topic:

- `/actions` — show current actions and recovery controls.
- `/status` — show compact process status.
- `/cancel` — cancel a pending action/continue prompt.
- `/skip` — skip the current optional action form field or continue with the default recovery prompt when available.
- `/help` — show topic help.

Close a mapped process topic to abort that process. The bot closes topics automatically when processes complete or abort.

Launch wizard prompts use Telegram-native controls where available: inline buttons for launcher choices, remembered recent values, select fields, boolean fields, skip/default choices, model setup, and final confirmation; force-reply prompts for required free-text and numeric fields. Required fields are asked first, then optional fields. Send `/skip` to keep a default value or skip an optional field. When a launcher has editable LLM model configuration, the final review includes a compact model summary and a **Change models** button. The model wizard lets operators choose a default model and per-turn overrides by button, number, or exact profile id; `/skip` keeps the current value and **Inherit** clears an override. Action form prompts also show a `Skip` button for optional fields. Successful launcher submissions update remembered values for future Telegram launches.

## Per-action model selection

When enabled (the default), the bot asks the operator to choose a next-turn model before executing any visible process action whose action plan selects an LLM turn. Action form fields are collected first, then the bot prompts with available model profiles and the resolved default model. When the operator's actual choice for a warm continuation (the previous turn ended within 30 minutes) would switch the underlying provider/model, the bot marks that choice with ⚠ and sends a cache-loss warning before executing the action. Thinking-level-only profile changes do not warn, root starts never warn, and the warning recommends the previous or an equivalent selectable profile when one is available. The operator can:

- pick a model by inline button, number, or exact profile id
- send `/skip` to keep the default/resolved model without an override
- send `/cancel` to discard

This only applies to actions that select an LLM turn. Non-LLM, unavailable-preview, and no-profile actions execute directly. Opt out with `action_model_selection.enabled: false`.

## Rendering

The extension receives leitwerk Markdown and sends Telegram messages with `HTML` parse mode. Unsupported Markdown degrades to escaped plain text. Messages longer than the configured Telegram message length are split into multiple ordered messages instead of being truncated.

Managed result images that belong to the published process turn are uploaded directly to Telegram; authenticated image URLs are never exposed to Telegram for fetching. Managed image references and Mermaid fences must be top-level Markdown blocks to become Telegram media. The extension sends those media blocks between ordinary rendered Markdown blocks; inline or list-nested image references remain escaped alt text. Each text section uses the normal message-length splitting. If Telegram rejects an image as a photo, the bot retries it as a document. Fenced Mermaid diagrams are rendered locally to PNG without a browser and uploaded as photos. Unsupported or invalid Mermaid syntax degrades to escaped diagram source. The Web UI and Telegram share the same lightweight Mermaid implementation, supporting flowcharts, state, sequence, class, ER, and XY diagrams.

For action-driven automatic work, the expected topic sequence is: submitted action summary (including entered form values), started turn, result markdown/log output when the turn finishes, then the next action prompt. Server-automatic turn results are posted from turn outcome markdown even when no leaf outcome snapshot is captured.

Opted-in LLM turns deliver durable operator questions to their process topic, including watcher- and scheduler-launched processes. Telegram shows the prepared options as guidance and collects one free-text reply per question; operators who want structured single- or multiple-selection controls can use the Web UI. The first valid Web or Telegram submission resumes the same active turn. Telegram rebuilds unanswered prompts from durable requests after restart and does not impose a question timeout.

## Reliability

Phase 1 delivery is best-effort:

- no replay of events missed while the bot is down,
- no exactly-once delivery guarantees,
- no message editing/deletion,
- pending form prompts are in memory and are lost on restart.

The process-to-topic mapping is persisted as extension-owned process events so replies keep routing after restart.
