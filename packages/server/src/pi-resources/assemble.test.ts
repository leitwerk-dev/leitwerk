import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CatalogPiContribution } from "@leitwerk-dev/extension-runtime";
import {
	createCanonicalPiResourceBundle,
	verifyCanonicalPiResourceBundle,
} from "@leitwerk-dev/worker-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { assemblePiResourceSnapshot } from "./assemble.js";

const tempDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function tempDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "leitwerk-pi-resources-"));
	tempDirectories.push(directory);
	return directory;
}

function contribution(input: {
	owner: string;
	workerEntryPath?: string;
	skillDirectories?: string[];
	promptDirectories?: string[];
}): CatalogPiContribution {
	return {
		ownerExtensionId: input.owner,
		packageName: `@test/${input.owner}`,
		...(input.workerEntryPath ? { workerEntryPath: input.workerEntryPath } : {}),
		resources: {
			skillDirectories: input.skillDirectories ?? [],
			promptDirectories: input.promptDirectories ?? [],
		},
	};
}

function assemblyInput(piContributions: readonly CatalogPiContribution[]) {
	return {
		piContributions,
		model: {
			profileId: "profile",
			providerId: "provider",
			modelId: "model",
			thinkingLevel: "medium",
		},
		providerOptions: { preferredAccount: "team" },
		providerWorkerConfig: { version: 1, value: { endpoint: "https://provider.invalid" } },
		piSettings: { theme: "dark", packages: ["ambient"], defaultProjectTrust: "always" },
		piModels: { providers: {}, modelOverrides: { provider: { model: { maxTokens: 8_192 } } } },
		declaredCredentialPaths: ["provider/credential.json", "auth.json"],
		compatibility: {
			workerApiVersion: "2026-07-22",
			piVersion: "0.81.1",
			protocolVersion: "leitwerk/worker-ipc/v1",
		},
		systemPrompt: "System prompt",
		appendSystemPrompt: "Append prompt",
	};
}

function extractedFiles(bytes: Uint8Array): Map<string, Uint8Array> {
	return new Map(
		verifyCanonicalPiResourceBundle(bytes).map((file) => [file.path, file.content] as const),
	);
}

describe("Pi resource snapshot assembly", () => {
	it("assembles generated files, ordered extension entries, complete skills, and prompts", async () => {
		const root = await tempDirectory();
		const firstEntry = path.join(root, "first.ts");
		const lastEntry = path.join(root, "last.js");
		const skills = path.join(root, "skills");
		const prompts = path.join(root, "prompts");
		await mkdir(path.join(skills, "review", "references"), { recursive: true });
		await mkdir(prompts, { recursive: true });
		await writeFile(firstEntry, "export default (_pi, ctx) => ctx.secrets.keys();\n");
		await writeFile(lastEntry, "export default (_pi, ctx) => ctx.report({ loaded: true });\n");
		await writeFile(path.join(skills, "review", "SKILL.md"), "# Review\n");
		await writeFile(path.join(skills, "review", "references", "rules.md"), "Rules\n");
		await writeFile(path.join(prompts, "explain.md"), "Explain {{topic}}\n");

		const assembled = await assemblePiResourceSnapshot(
			assemblyInput([
				contribution({ owner: "first", workerEntryPath: firstEntry }),
				contribution({
					owner: "resources",
					skillDirectories: [skills],
					promptDirectories: [prompts],
				}),
				contribution({ owner: "last", workerEntryPath: lastEntry }),
			]),
		);
		const files = extractedFiles(assembled.bundle.bytes);

		expect([...files.keys()]).toEqual([
			"APPEND_SYSTEM.md",
			"SYSTEM.md",
			"extensions/000-first.js",
			"extensions/020-last.js",
			"generated.json",
			"models.json",
			"prompts/explain.md",
			"settings.json",
			"skills/review/SKILL.md",
			"skills/review/references/rules.md",
		]);
		const firstWrapper = Buffer.from(files.get("extensions/000-first.js") ?? []).toString();
		expect(firstWrapper).toContain("as default}");
		expect(firstWrapper).toContain("generated.json");
		expect(firstWrapper).not.toContain("@leitwerk-dev/process-sdk");
		expect(JSON.parse(Buffer.from(files.get("settings.json") ?? []).toString())).toEqual({
			defaultProjectTrust: "never",
			packages: [],
			theme: "dark",
		});
		expect(JSON.parse(Buffer.from(files.get("models.json") ?? []).toString())).toEqual({
			modelOverrides: { provider: { model: { maxTokens: 8_192 } } },
			providers: {},
		});
		const generated = JSON.parse(Buffer.from(files.get("generated.json") ?? []).toString());
		expect(generated).toMatchObject({
			schemaVersion: 1,
			model: { providerId: "provider", modelId: "model" },
			providerOptions: { preferredAccount: "team" },
			providerWorkerConfig: {
				version: 1,
				value: { endpoint: "https://provider.invalid" },
			},
			declaredCredentialPaths: ["auth.json", "provider/credential.json"],
			compatibility: { workerApiVersion: "2026-07-22", piVersion: "0.81.1" },
		});
		expect(generated.provenance).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "extension",
					ownerExtensionId: "first",
					snapshotPath: "extensions/000-first.js",
					sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				}),
				expect.objectContaining({
					kind: "skill",
					snapshotPath: "skills/review/SKILL.md",
				}),
			]),
		);
		expect(files.has("auth.json")).toBe(false);
		expect(files.has("provider/credential.json")).toBe(false);
	});

	it("composes and verifies a pinned canonical resource layer", async () => {
		const layer = createCanonicalPiResourceBundle([
			{ path: "skills/review/SKILL.md", content: Buffer.from("# Review\n") },
			{ path: "skills/review/rules.md", content: Buffer.from("Rules\n") },
		]);
		const assembled = await assemblePiResourceSnapshot({
			...assemblyInput([]),
			resourceLayers: [
				{
					bundle: layer,
					owner: { kind: "skill", ownerExtensionId: null, packageName: null },
				},
			],
		});
		const files = extractedFiles(assembled.bundle.bytes);
		expect(Buffer.from(files.get("skills/review/SKILL.md") ?? []).toString()).toBe("# Review\n");
		expect(assembled.generated.provenance).toContainEqual(
			expect.objectContaining({
				kind: "skill",
				ownerExtensionId: null,
				packageName: null,
				snapshotPath: "skills/review/SKILL.md",
			}),
		);

		await expect(
			assemblePiResourceSnapshot({
				...assemblyInput([]),
				resourceLayers: [
					{
						bundle: {
							...layer,
							bytes: Uint8Array.from(layer.bytes, (byte, index) => (index === 0 ? byte ^ 1 : byte)),
						},
						owner: { kind: "skill", ownerExtensionId: null, packageName: null },
					},
				],
			}),
		).rejects.toThrow(/content digest mismatch/);
	});

	it("produces identical bytes regardless of JSON key and directory creation order", async () => {
		const root = await tempDirectory();
		const prompts = path.join(root, "prompts");
		await mkdir(prompts);
		await writeFile(path.join(prompts, "z.md"), "z");
		await writeFile(path.join(prompts, "a.md"), "a");
		const catalog = [contribution({ owner: "prompts", promptDirectories: [prompts] })];
		const firstInput = assemblyInput(catalog);
		const secondInput = {
			...assemblyInput(catalog),
			providerOptions: { preferredAccount: "team" },
			piSettings: {
				defaultProjectTrust: "always",
				packages: ["ambient"],
				theme: "dark",
			},
		};
		const [first, second] = await Promise.all([
			assemblePiResourceSnapshot(firstInput),
			assemblePiResourceSnapshot(secondInput),
		]);
		expect(second.bundle.digest).toBe(first.bundle.digest);
		expect(second.bundle.bytes).toEqual(first.bundle.bytes);
	});

	it("reads the exact source or dist entry path supplied by the catalog", async () => {
		const root = await tempDirectory();
		const sourceEntry = path.join(root, "pi-worker.ts");
		const distEntry = path.join(root, "pi-worker.js");
		await writeFile(sourceEntry, "export default () => 'source lane';");
		await writeFile(distEntry, "export default () => 'dist lane';");

		const source = await assemblePiResourceSnapshot(
			assemblyInput([contribution({ owner: "provider", workerEntryPath: sourceEntry })]),
		);
		const dist = await assemblePiResourceSnapshot(
			assemblyInput([contribution({ owner: "provider", workerEntryPath: distEntry })]),
		);
		expect(
			Buffer.from(
				extractedFiles(source.bundle.bytes).get("extensions/000-provider.js") ?? [],
			).toString(),
		).toContain("source lane");
		expect(
			Buffer.from(
				extractedFiles(dist.bundle.bytes).get("extensions/000-provider.js") ?? [],
			).toString(),
		).toContain("dist lane");
	});

	it("loads a bundled standard Pi extension with generated worker context", async () => {
		const root = await tempDirectory();
		const entry = path.join(root, "pi-worker.ts");
		await writeFile(
			entry,
			`export default (pi, ctx) => pi.events.emit("contribution", { model: ctx.model, option: ctx.options.account, config: ctx.workerConfig.endpoint, secret: ctx.secrets.require("token") });`,
		);
		const assembled = await assemblePiResourceSnapshot(
			assemblyInput([contribution({ owner: "provider", workerEntryPath: entry })]),
		);
		for (const file of verifyCanonicalPiResourceBundle(assembled.bundle.bytes)) {
			const target = path.join(root, file.path);
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, file.content);
		}
		await mkdir(path.join(root, "provider"), { recursive: true });
		await writeFile(path.join(root, "auth.json"), "{}\n");
		await writeFile(path.join(root, "provider", "credential.json"), '{"token":"secret"}\n');
		const extension = await import(
			pathToFileURL(path.join(root, "extensions", "000-provider.js")).href
		);
		const events: unknown[] = [];
		await extension.default({
			events: { emit: (_name: string, event: unknown) => events.push(event) },
		});
		expect(events).toEqual([
			{
				model: { providerId: "provider", modelId: "model" },
				option: undefined,
				config: "https://provider.invalid",
				secret: "secret",
			},
		]);
	});

	it("rejects symlinks, special roots, physical duplicates, and target collisions", async () => {
		const root = await tempDirectory();
		const skills = path.join(root, "skills");
		const outside = path.join(root, "outside.md");
		await mkdir(skills);
		await writeFile(outside, "outside");
		await symlink(outside, path.join(skills, "escaped.md"));
		await expect(
			assemblePiResourceSnapshot(
				assemblyInput([contribution({ owner: "unsafe", skillDirectories: [skills] })]),
			),
		).rejects.toThrow(/Symbolic links are forbidden/);

		await expect(
			assemblePiResourceSnapshot(
				assemblyInput([contribution({ owner: "not-directory", skillDirectories: [outside] })]),
			),
		).rejects.toThrow(/must be a real directory/);
		await expect(
			assemblePiResourceSnapshot(
				assemblyInput([
					contribution({
						owner: "escape",
						workerEntryPath: `${root}${path.sep}nested${path.sep}..${path.sep}outside.md`,
					}),
				]),
			),
		).rejects.toThrow(/must be normalized and absolute/);

		const entry = path.join(root, "entry.js");
		const hardLink = path.join(root, "entry-copy.js");
		await writeFile(entry, "entry");
		await link(entry, hardLink);
		await expect(
			assemblePiResourceSnapshot(
				assemblyInput([
					contribution({ owner: "one", workerEntryPath: entry }),
					contribution({ owner: "two", workerEntryPath: hardLink }),
				]),
			),
		).rejects.toThrow(/Physical Pi resource file is included more than once/);

		const promptsA = path.join(root, "prompts-a");
		const promptsB = path.join(root, "prompts-b");
		await mkdir(promptsA);
		await mkdir(promptsB);
		await writeFile(path.join(promptsA, "same.md"), "a");
		await writeFile(path.join(promptsB, "same.md"), "b");
		await expect(
			assemblePiResourceSnapshot(
				assemblyInput([
					contribution({ owner: "a", promptDirectories: [promptsA] }),
					contribution({ owner: "b", promptDirectories: [promptsB] }),
				]),
			),
		).rejects.toThrow(/Duplicate Pi resource snapshot path 'prompts\/same.md'/);
	});

	it("rejects credential-bearing generated inputs and credential path overlaps", async () => {
		await expect(
			assemblePiResourceSnapshot({
				...assemblyInput([]),
				providerWorkerConfig: { version: 1, value: { apiKey: "do-not-store" } },
			}),
		).rejects.toThrow(/credential-bearing/);
		await expect(
			assemblePiResourceSnapshot({
				...assemblyInput([]),
				declaredCredentialPaths: ["settings.json"],
			}),
		).rejects.toThrow(/overlaps immutable resource/);
	});
});
