import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagedPiResourceManifest } from "./managed-pi-bootstrap.js";
import { SdkPiTreeHandleFactory } from "./pi-adapter.js";
import { testConfigSnapshot } from "./test-helpers/ipc-harness.js";

const tempDirs: string[] = [];

async function createTempRoot(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "leitwerk-pi-provider-extension-"));
	tempDirs.push(dir);
	return dir;
}

async function writePiExtension(agentDir: string, source: string): Promise<void> {
	const extensionDir = path.join(agentDir, "extensions", "test-provider");
	await mkdir(extensionDir, { recursive: true });
	await writeFile(path.join(extensionDir, "index.ts"), source);
}

function providerExtensionSource(baseUrl = "https://example.invalid/v1"): string {
	return `
export default function providerExtension(pi) {
  pi.registerProvider("extension-provider", {
    name: "Extension Provider",
    baseUrl: ${JSON.stringify(baseUrl)},
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

function createConfig(agentDir: string) {
	const config = testConfigSnapshot();
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

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SdkPiTreeHandleFactory Pi provider extensions", () => {
	it("preflights standard Pi resources and reports verified loaded provenance", async () => {
		const root = await createTempRoot();
		const agentDir = path.join(root, "agent");
		const workspaceRoot = path.join(root, "workspace");
		await mkdir(path.join(agentDir, "skills", "review"), { recursive: true });
		await mkdir(path.join(agentDir, "prompts"), { recursive: true });
		await mkdir(path.join(workspaceRoot, ".agents", "skills", "ambient"), { recursive: true });
		await writeFile(path.join(agentDir, "settings.json"), "{}\n");
		await writeFile(path.join(agentDir, "models.json"), '{"providers":{}}\n');
		await writeFile(
			path.join(agentDir, "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review changes\n---\nReview the changes.\n",
		);
		await writeFile(
			path.join(workspaceRoot, ".agents", "skills", "ambient", "SKILL.md"),
			"---\nname: ambient\ndescription: Must not load\n---\nAmbient skill.\n",
		);
		await writeFile(
			path.join(agentDir, "prompts", "explain.md"),
			"---\ndescription: Explain a change\n---\nExplain $@.\n",
		);
		await writePiExtension(agentDir, providerExtensionSource());
		const manifest: ManagedPiResourceManifest = {
			schemaVersion: 1,
			model: {
				profileId: "extension-profile",
				providerId: "extension-provider",
				modelId: "extension-model",
				thinkingLevel: "medium",
			},
			providerOptions: {},
			providerWorkerConfig: null,
			declaredCredentialPaths: ["auth.json"],
			compatibility: { workerApiVersion: "test", piVersion: "test" },
			provenance: [
				["generated", "settings.json"],
				["generated", "models.json"],
				["extension", "extensions/test-provider/index.ts"],
				["skill", "skills/review/SKILL.md"],
				["prompt", "prompts/explain.md"],
			].map(([kind, snapshotPath]) => ({
				kind: kind as ManagedPiResourceManifest["provenance"][number]["kind"],
				ownerExtensionId: kind === "generated" ? null : "test",
				packageName: kind === "generated" ? null : "test",
				snapshotPath: snapshotPath ?? "",
				sha256: "0".repeat(64),
				size: 0,
			})),
		};
		const result = await new SdkPiTreeHandleFactory().prepareManagedBootstrap({
			agentDir,
			workspaceRoot,
			sessionCwd: workspaceRoot,
			configSnapshot: createConfig(agentDir),
			piConfig: { availableToolNames: [] },
			manifest,
			expectedModel: { providerId: "extension-provider", modelId: "extension-model" },
		});

		expect(result.resolvedModel).toEqual({
			providerId: "extension-provider",
			modelId: "extension-model",
		});
		expect(result.loadedResourceIds).toEqual(
			manifest.provenance.map((resource) => resource.snapshotPath),
		);
		expect(result.loadedSkillFiles).toEqual([
			expect.objectContaining({
				name: "review",
				path: path.join(agentDir, "skills/review/SKILL.md"),
			}),
		]);
	});

	it("executes authenticated requests through providers registered by pi.agent_dir extensions", async () => {
		let authorization: string | undefined;
		const server = createServer((request, response) => {
			authorization = request.headers.authorization;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				[
					'data: {"id":"completion-1","object":"chat.completion.chunk","created":1,"model":"extension-model","choices":[{"index":0,"delta":{"role":"assistant","content":"authenticated"},"finish_reason":null}]}',
					'data: {"id":"completion-1","object":"chat.completion.chunk","created":1,"model":"extension-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
					"data: [DONE]",
					"",
				].join("\n\n"),
			);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		const root = await createTempRoot();
		const agentDir = path.join(root, "agent");
		const workspaceRoot = path.join(root, "workspace");
		await Promise.all([
			mkdir(workspaceRoot, { recursive: true }),
			mkdir(agentDir, { recursive: true }),
		]);
		await writeFile(path.join(agentDir, "auth.json"), "{}\n");
		const address = server.address() as AddressInfo;
		await writePiExtension(
			agentDir,
			providerExtensionSource(`http://127.0.0.1:${address.port}/v1`),
		);

		const handle = await new SdkPiTreeHandleFactory().createPrimaryTreeHandle({
			instanceId: "pi-provider-extension-test",
			treeFile: path.join(root, "tree.jsonl"),
			workspaceRoot,
			resume: false,
			configSnapshot: createConfig(agentDir),
			modelProfileId: "extension-profile",
		});

		try {
			await expect(handle.prompt("Authenticate this request")).resolves.toBeDefined();
			expect(authorization).toBe("Bearer test-key");
			expect(handle.getBranch()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "model_change",
						provider: "extension-provider",
						modelId: "extension-model",
					}),
				]),
			);
		} finally {
			await handle.close();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("includes pi extension load diagnostics when an extension provider model cannot be resolved", async () => {
		const root = await createTempRoot();
		const agentDir = path.join(root, "agent");
		const workspaceRoot = path.join(root, "workspace");
		await mkdir(workspaceRoot, { recursive: true });
		await writePiExtension(
			agentDir,
			`export default function brokenProviderExtension() { throw new Error("provider setup exploded"); }`,
		);

		await expect(
			new SdkPiTreeHandleFactory().createPrimaryTreeHandle({
				instanceId: "pi-provider-extension-load-failure-test",
				treeFile: path.join(root, "tree.jsonl"),
				workspaceRoot,
				resume: false,
				configSnapshot: createConfig(agentDir),
				modelProfileId: "extension-profile",
			}),
		).rejects.toThrow(/provider setup exploded/);
	});

	it("includes pi provider registration diagnostics when an extension provider model cannot be resolved", async () => {
		const root = await createTempRoot();
		const agentDir = path.join(root, "agent");
		const workspaceRoot = path.join(root, "workspace");
		await mkdir(workspaceRoot, { recursive: true });
		await writePiExtension(
			agentDir,
			`
export default function invalidProviderExtension(pi) {
  pi.registerProvider("extension-provider", {
    apiKey: "test-key",
    api: "openai-completions",
    models: [
      {
        id: "extension-model",
        name: "Extension Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
    ],
  });
}
`,
		);

		await expect(
			new SdkPiTreeHandleFactory().createPrimaryTreeHandle({
				instanceId: "pi-provider-extension-registration-failure-test",
				treeFile: path.join(root, "tree.jsonl"),
				workspaceRoot,
				resume: false,
				configSnapshot: createConfig(agentDir),
				modelProfileId: "extension-profile",
			}),
		).rejects.toThrow(/baseUrl/);
	});
});
