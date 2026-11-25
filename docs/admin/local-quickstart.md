# Run a local process with a live model

Configure one OpenAI model and run **Single Prompt** to check that a local worker can use it. For a credential-free first run, use the [sandbox tutorial](index.md).

Use a Leitwerk source checkout on macOS or Linux with Git, Node.js 26.x, npm, and OpenSSL. Local workers run with the permissions of your OS user. For container isolation, see [Docker deployment](deploy-docker.md) or [Kubernetes deployment](deploy-kubernetes.md).

## Configure the server

From the checkout root, install dependencies and create a new local configuration. If `.leitwerk/local/leitwerk.yaml` already exists, keep it and review the example before editing it.

```sh
npm ci
mkdir -p .leitwerk/local
(set -C; umask 077; cat docs/examples/local/leitwerk.example.yaml > .leitwerk/local/leitwerk.yaml)
```

The [complete example](../examples/local/leitwerk.example.yaml) loads the model provider and the extension that supplies **Single Prompt**. Set `pi.model_profiles[0].model_id` to a model your OpenAI account can use and export `OPENAI_API_KEY` in this shell. The environment key seeds the empty encrypted credential store on first startup. Later startups use the stored credential. See [Models](models.md) for other providers and credential rotation.

Create an encryption key for this database once, then load it in each shell that starts Leitwerk.

```sh
if [ ! -e .leitwerk/local/credential-key ] && [ ! -e .leitwerk/local/leitwerk.sqlite ]; then
  (set -C; umask 077; openssl rand -base64 32 > .leitwerk/local/credential-key)
fi
read -r LEITWERK_CREDENTIAL_ENCRYPTION_KEY < .leitwerk/local/credential-key
export LEITWERK_CREDENTIAL_ENCRYPTION_KEY
```

Keep the key with your database backups. If you already have a database and the key file is missing, restore the matching key before starting Leitwerk.

## Run a prompt

```sh
LEITWERK_CONFIG_PATH="$PWD/.leitwerk/local/leitwerk.yaml" npm run dev
```

1. Open the Vite URL printed in the terminal.
2. Choose **Start a process** and select **Single Prompt**.
3. Enter `Reply with the word hello.`, choose `example_model` if a model selection is shown, and click **Run Prompt**.
4. In the **Chronicle**, verify that the model returned a reply and the process reaches **Completed**.

Stop with `Ctrl+C`. To reopen the process later, run the same command from the checkout root with the same encryption key. The database and tree files stay under `.leitwerk/local/`.

If the model is unavailable, check the model ID and stored credential. For a failed turn, open the error in the Chronicle. [Models](models.md) · [Operate processes](../users/operate-processes.md)
