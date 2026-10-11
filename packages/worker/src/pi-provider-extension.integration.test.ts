import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionInspectionCapture } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import type { ManagedPiResourceManifest } from "./managed-pi-bootstrap.js";
import { SdkPiTreeHandleFactory } from "./pi-adapter.js";

import {
	createConfig,
	createPiProviderFixture,
	createTempRoot,
	providerExtensionSource,
	writePiExtension,
} from "./test-helpers/pi-provider.js";

describe("SdkPiTreeHandleFactory Pi provider extensions", () => {
	it("preflights standard Pi resources and reports loaded provenance", async () => {
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
		const handle = await createPiProviderFixture((request) => {
			authorization = request.headers.authorization;
			return { content: "authenticated" };
		});
		const observations: ExecutionInspectionCapture[] = [];
		handle.subscribe((event) => {
			if (event.type === "inspection")
				observations.push(event.data.capture as ExecutionInspectionCapture);
		});
		await expect(handle.prompt("Authenticate this request")).resolves.toBeDefined();
		expect(authorization).toBe("Bearer test-key");
		const modelInput = observations.find((item) => item.fact.kind === "model_input");
		expect(modelInput?.fact).toMatchObject({
			kind: "model_input",
			model: { provider: "extension-provider", id: "extension-model" },
			systemPrompt: { state: "recorded" },
			tools: { state: "recorded", value: [] },
			messages: [
				{
					role: "system",
					entryId: expect.any(String),
					content: { state: "recorded" },
				},
				{
					role: "user",
					entryId: expect.any(String),
					content: {
						state: "recorded",
						value: [{ type: "text", text: "Authenticate this request" }],
					},
				},
			],
		});
		await handle.prompt("Continue with another model call");
		const modelInputs = observations.filter((item) => item.fact.kind === "model_input");
		expect(modelInputs).toHaveLength(2);
		expect(new Set(modelInputs.map((item) => item.id)).size).toBe(2);
		expect(modelInputs[1].fact).toMatchObject({
			messages: expect.arrayContaining([
				{
					role: "user",
					entryId: expect.any(String),
					content: {
						state: "recorded",
						value: [{ type: "text", text: "Continue with another model call" }],
					},
				},
			]),
		});
		expect(JSON.stringify(observations)).not.toContain("test-key");
		expect(
			observations.some(
				(item) => item.fact.kind === "entry_link" && item.fact.entryId === handle.getLeafId(),
			),
		).toBe(true);
		expect(handle.getBranch()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "model_change",
					provider: "extension-provider",
					modelId: "extension-model",
				}),
			]),
		);
	});

	it.each([
		[
			"extension load",
			`export default function brokenProviderExtension() { throw new Error("provider setup exploded"); }`,
			/provider setup exploded/,
		],
		["provider registration", providerExtensionSource(null), /baseUrl/],
	] as const)("includes pi %s diagnostics when an extension provider model cannot be resolved", async (_diagnostic, source, expectedError) => {
		const root = await createTempRoot();
		const agentDir = path.join(root, "agent");
		const workspaceRoot = path.join(root, "workspace");
		await mkdir(workspaceRoot, { recursive: true });
		await writePiExtension(agentDir, source);

		await expect(
			new SdkPiTreeHandleFactory().createPrimaryTreeHandle({
				instanceId: "pi-provider-extension-failure-test",
				treeFile: path.join(root, "tree.jsonl"),
				workspaceRoot,
				resume: false,
				configSnapshot: createConfig(agentDir),
				modelProfileId: "extension-profile",
			}),
		).rejects.toThrow(expectedError);
	});
});
