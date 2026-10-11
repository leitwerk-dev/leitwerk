import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import type { FakeLlmProvider } from "@leitwerk-dev/test-support";
import { createTestConfigSnapshot } from "@leitwerk-dev/worker-protocol";
import { onTestFinished } from "vitest";
import { SdkPiTreeHandleFactory } from "../pi-adapter.js";

/** @internal */
export async function createTempRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-pi-provider-extension-"));
	onTestFinished(() => rm(root, { recursive: true, force: true }));
	return root;
}

/** @internal */
export async function writePiExtension(agentDir: string, source: string): Promise<void> {
	const extensionDir = path.join(agentDir, "extensions", "test-provider");
	await mkdir(extensionDir, { recursive: true });
	await writeFile(path.join(extensionDir, "index.ts"), source);
}

/** @internal */
export function providerExtensionSource(
	baseUrl: string | null = "https://example.invalid/v1",
): string {
	return `
export default function providerExtension(pi) {
  pi.registerProvider("extension-provider", {
    name: "Extension Provider",
    ${baseUrl === null ? "" : `baseUrl: ${JSON.stringify(baseUrl)},`}
    apiKey: "test-key",
    api: "openai-completions",
    models: [
      {
        id: "extension-model",
        name: "Extension Model",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
    ],
  });
}
`;
}

/** @internal */
export function createConfig(agentDir: string) {
	const config = createTestConfigSnapshot();
	config.pi.agent_dir = agentDir;
	config.pi.model_profiles = [
		{
			id: "extension-profile",
			provider: "extension-provider",
			model_id: "extension-model",
		},
	];
	return config;
}

/** @internal */
export async function createPiProviderFixture(
	respond: (request: IncomingMessage, body: string) => ReturnType<FakeLlmProvider["respond"]>,
) {
	const root = await createTempRoot();
	const agentDir = path.join(root, "agent");
	const workspaceRoot = path.join(root, "workspace");
	await mkdir(workspaceRoot, { recursive: true });
	let sequence = 0;
	const server = createServer(async (request, response) => {
		const answer = respond(request, await text(request));
		sequence += 1;
		const toolCalls = answer.toolCalls?.map((call, index) => ({
			index,
			id: `call-${sequence}-${index}`,
			type: "function",
			function: { name: call.name, arguments: JSON.stringify(call.arguments) },
		}));
		const chunk = (delta: unknown, finish_reason: string | null) =>
			`data: ${JSON.stringify({
				id: `completion-${sequence}`,
				object: "chat.completion.chunk",
				created: 1,
				model: "extension-model",
				choices: [{ index: 0, delta, finish_reason }],
			})}\n\n`;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(
			chunk({ role: "assistant", content: answer.content, tool_calls: toolCalls }, null) +
				chunk({}, toolCalls?.length ? "tool_calls" : "stop") +
				"data: [DONE]\n\n",
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	onTestFinished(
		() =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	);
	await writePiExtension(
		agentDir,
		providerExtensionSource(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`),
	);
	await writeFile(path.join(agentDir, "auth.json"), "{}\n");
	const handle = await new SdkPiTreeHandleFactory().createPrimaryTreeHandle({
		instanceId: "pi-provider-extension-test",
		treeFile: path.join(root, "tree.jsonl"),
		workspaceRoot,
		resume: false,
		configSnapshot: createConfig(agentDir),
		modelProfileId: "extension-profile",
	});
	onTestFinished(() => handle.close());
	return handle;
}
