# Run your first process

Run Leitwerk from a source checkout, then use **Single Prompt** to complete one LLM turn.
This setup uses local workers. They run as your OS user and are not an isolation boundary.
For container isolation, use the [Docker](docker-deployment-guide.md) or
[Kubernetes](kubernetes-deployment-guide.md) guide.

## Prerequisites

- macOS or Linux, Git, Node.js 26.x, and npm.
- A checkout of this repository.
- Access to a model provider. The example below uses an OpenAI API key; substitute
  another configured [model provider](models.md) if needed.

For a UI-only demonstration without provider credentials, use `npm run dev:sandbox`
after installing dependencies. See the
[sandbox guide](https://github.com/leitwerk-dev/leitwerk/blob/main/sandbox/README.md).

## Configure local execution

From the repository root:

```sh
npm ci
cp leitwerk.yaml.example leitwerk.yaml
chmod 600 leitwerk.yaml
```

Edit the existing sections in `leitwerk.yaml`; do not append duplicate YAML keys:

```yaml
workers:
  runner: local

pi:
  agent_dir: ~/.pi/leitwerk
  model_profiles:
    - id: example_model
      provider: openai
      model_id: gpt-4o

extensions:
  models:
    openai:
      api_key: env:OPENAI_API_KEY
```

Keep the example's `storage` paths and `extension_loading.sources`, which load the
models and showcase extensions. Choose a model ID your provider account can use.
The profile ID is your own name for that selection.

Set `OPENAI_API_KEY` in the launching shell through your usual secret manager.
Leitwerk uses it to initialize the encrypted server credential store. An existing
stored credential takes precedence on restart.

Generate an encryption key once for this local database:

```sh
mkdir -p .leitwerk
(set -C; umask 077; openssl rand -base64 32 > .leitwerk/credential-key)
read -r LEITWERK_CREDENTIAL_ENCRYPTION_KEY < .leitwerk/credential-key
export LEITWERK_CREDENTIAL_ENCRYPTION_KEY
```

Do not repeat key generation for an existing database. Retain the same key across
restarts and protect it with your backups. Never commit it.

Workers use Leitwerk-managed resources under `pi.agent_dir`. They do not import
your ambient `~/.pi/agent` files. Configure providers through Leitwerk rather than
copying an ambient Pi credential directory.

## Start and launch

```sh
npm run dev
```

Open the Vite URL printed by the command. On the launcher page:

1. Choose **Single Prompt**.
2. Enter a short instruction, such as “Explain what a code review checks.”
3. Select `example_model` and submit.
4. Follow startup and output in the process timeline, called the **Chronicle**.

The process completes when the assistant finishes. Its recorded output remains
available in the Chronicle. To try a human decision, launch **Poem Creator** and
review its draft. These are optional
[showcase processes](https://github.com/leitwerk-dev/leitwerk/blob/main/extensions/showcase-processes/README.md),
not special cases in the runtime.

Stop the development server with Ctrl+C. Restart it from the same directory with
the same configuration and encryption key.

## If it does not start

| Symptom | Check |
| --- | --- |
| No launchers | Keep the showcase extension in `extension_loading.sources`. Paths resolve from the configuration file's directory. |
| Model unavailable | Check the provider extension, model ID, credentials, and encryption key. See [Models](models.md). |
| Worker image or Docker error | Set `workers.runner: local` for this walkthrough. |
| Credential decryption error | Restore the key associated with this database. Do not delete the database to bypass the error. |
| Failed startup or turn | Open the failure details, fix the cause, then use the offered recovery action. See [Operate a process](operator-guide.md#recover-failed-work). |

Next: [operate a process](operator-guide.md) or [write your own](first-process.md).

Use Settings to edit installation and repository defaults supplied by extensions.
New steps capture those defaults; changing them preserves already prepared and
completed work. See [Scoped settings](scoped-settings.md).
