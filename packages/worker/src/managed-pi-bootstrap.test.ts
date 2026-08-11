import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { ResolvedTurnStart } from "@leitwerk-dev/domain";
import { IPC_PROTOCOL_VERSION, WORKER_API_VERSION } from "@leitwerk-dev/worker-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { writeManagedPiCredentialFiles } from "./managed-pi-agent-dir.js";
import {
	buildManagedPiCredentialFiles,
	readAndValidateManagedPiResourceManifest,
} from "./managed-pi-bootstrap.js";
import {
	createCanonicalPiResourceBundle,
	materializeCanonicalPiResourceBundle,
	sha256Digest,
} from "./pi-resource-bundle.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const start: Extract<ResolvedTurnStart, { kind: "llm" }> = {
	kind: "llm",
	model: {
		profileId: "openai-default",
		providerId: "openai",
		modelId: "gpt-5",
		thinkingLevel: "medium",
	},
	providerOptions: {},
	providerWorkerConfig: null,
	piResourceSnapshotDigest: "assigned-after-bundle",
	workerRuntimeProfileId: "default",
	piSettings: { theme: "dark" },
};

async function materializeTestBundle(input: { modelId?: string }) {
	const root = await mkdtemp(path.join(tmpdir(), "managed-pi-bootstrap-test-"));
	roots.push(root);
	const targetDir = path.join(root, "agent");
	const immutableFiles = [
		{
			path: "settings.json",
			content: Buffer.from('{"defaultProjectTrust":"never","packages":[],"theme":"dark"}\n'),
		},
		{ path: "models.json", content: Buffer.from('{"providers":{}}\n') },
	];
	const generated = {
		schemaVersion: 1,
		model: { ...start.model, modelId: input.modelId ?? start.model.modelId },
		providerOptions: {},
		providerWorkerConfig: null,
		declaredCredentialPaths: ["auth.json"],
		compatibility: {
			workerApiVersion: WORKER_API_VERSION,
			piVersion: PI_VERSION,
			protocolVersion: IPC_PROTOCOL_VERSION,
		},
		provenance: immutableFiles.map((file) => ({
			kind: "generated",
			ownerExtensionId: null,
			packageName: null,
			snapshotPath: file.path,
			sha256: sha256Digest(file.content),
			size: file.content.byteLength,
		})),
	};
	const bundle = createCanonicalPiResourceBundle([
		...immutableFiles,
		{ path: "generated.json", content: Buffer.from(`${JSON.stringify(generated)}\n`) },
	]);
	await materializeCanonicalPiResourceBundle({
		bundle: bundle.bytes,
		digest: bundle.digest,
		targetDir,
	});
	return { targetDir, bundle };
}

describe("managed Pi bootstrap validation", () => {
	it("validates the generated manifest and projects OpenAI into standard auth.json", async () => {
		const { targetDir, bundle } = await materializeTestBundle({});
		const manifest = await readAndValidateManagedPiResourceManifest({
			agentDir: targetDir,
			resourceDigest: bundle.digest,
			start,
		});
		const files = buildManagedPiCredentialFiles({
			manifest,
			providerId: "openai",
			credential: { providerId: "openai", revision: 4, values: { apiKey: "sk-test" } },
		});

		expect(files).toEqual([
			{
				path: "auth.json",
				content: `${JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }, null, 2)}\n`,
			},
		]);
	});

	it("projects an unversioned generated credential into auth.json", async () => {
		const { targetDir, bundle } = await materializeTestBundle({});
		const manifest = await readAndValidateManagedPiResourceManifest({
			agentDir: targetDir,
			resourceDigest: bundle.digest,
			start,
		});
		const files = buildManagedPiCredentialFiles({
			manifest,
			providerId: "openai",
			credential: { providerId: "openai", revision: null, values: { apiKey: "generated" } },
		});

		expect(files).toEqual([
			{
				path: "auth.json",
				content: `${JSON.stringify({ openai: { type: "api_key", key: "generated" } }, null, 2)}\n`,
			},
		]);
	});

	it("keeps provider-specific secrets out of auth.json", () => {
		const manifest = {
			schemaVersion: 1 as const,
			model: start.model,
			providerOptions: {},
			providerWorkerConfig: null,
			declaredCredentialPaths: ["auth.json", "credentials/provider.json"],
			compatibility: { workerApiVersion: "test", piVersion: "test" },
			provenance: [],
		};

		expect(
			buildManagedPiCredentialFiles({
				manifest,
				providerId: "provider",
				credential: {
					providerId: "provider",
					revision: 1,
					values: { brokerToken: "broker-secret" },
				},
			}),
		).toEqual([
			{ path: "auth.json", content: "{}\n" },
			{
				path: "credentials/provider.json",
				content: `${JSON.stringify({ brokerToken: "broker-secret" }, null, 2)}\n`,
			},
		]);
	});

	it("rejects a generated model that differs from the durable start", async () => {
		const { targetDir, bundle } = await materializeTestBundle({ modelId: "other-model" });
		await expect(
			readAndValidateManagedPiResourceManifest({
				agentDir: targetDir,
				resourceDigest: bundle.digest,
				start,
			}),
		).rejects.toThrow("does not match start");
	});

	it("revalidates a retained snapshot after its declared credential layer is present", async () => {
		const { targetDir, bundle } = await materializeTestBundle({});
		const first = await readAndValidateManagedPiResourceManifest({
			agentDir: targetDir,
			resourceDigest: bundle.digest,
			start,
		});
		await writeManagedPiCredentialFiles(
			targetDir,
			buildManagedPiCredentialFiles({
				manifest: first,
				providerId: "openai",
				credential: { providerId: "openai", revision: 4, values: { apiKey: "sk-test" } },
			}),
		);

		await expect(
			readAndValidateManagedPiResourceManifest({
				agentDir: targetDir,
				resourceDigest: bundle.digest,
				start,
			}),
		).resolves.toEqual(first);
	});
});
