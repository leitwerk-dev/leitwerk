# Pi Shell Extension

`@leitwerk-dev/pi-shell` provides `pi_shell_process`, a minimal linear Pi session for trusted recovery work focused on a configured local directory.

## Safety model

This extension is intended for trusted local recovery use. It exposes only Pi's built-in `read`, `bash`, `edit`, and `write` tools. It does not register outcome tools. Each LLM turn ends through normal `turn_end`, and the assistant's final response is captured as the durable turn result markdown. When controlled through Telegram, submitted prompts and assistant-result markdown are posted in the process topic before the next prompt action.

This is not an OS or filesystem sandbox. The configured directory is the Pi session working directory and default target/focus for prompts; tools can still access anything the worker process can access. Use this extension only in trusted local operator environments.

## Loading

```yaml
extension_loading:
  sources:
    - ./extensions/pi-shell
```

## Process graph

```text
open_session [server_automatic/active]
  ├─ opened      -> prompt_console
  └─ run_initial -> run_prompt

prompt_console [human/waiting]
  ├─ send_prompt -> run_prompt
  └─ close_session -> completed

run_prompt [llm/active]
  └─ turn_end/responded -> prompt_console
```

## Operator flow

1. Launch **Pi Shell**.
2. Set an existing default target directory, for example the primary leitwerk checkout.
3. Optionally provide an initial prompt to run immediately.
4. Send follow-up prompts from the console turn.
5. Close the session when finished.
