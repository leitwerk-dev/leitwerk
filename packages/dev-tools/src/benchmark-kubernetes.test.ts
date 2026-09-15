import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { kubernetesEvidence } from "./benchmark-kubernetes.js";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("captures a selected deployment without local Git and rejects a different image", () => {
	const root = mkdtempSync(path.join(tmpdir(), "leitwerk-benchmark-kube-"));
	roots.push(root);
	mkdirSync(path.join(root, "bin"));
	const calls = path.join(root, "calls.jsonl");
	const deployment = {
		metadata: { uid: "deployment-uid" },
		spec: {
			selector: { matchLabels: { app: "custom-server" } },
			template: {
				metadata: { annotations: { "leitwerk.dev/git-sha": "example-sha", unrelated: "excluded" } },
				spec: { containers: [{ name: "server", image: "example/server@sha256:abcd" }] },
			},
		},
	};
	const pods = {
		items: [
			{
				metadata: { name: "custom-pod", uid: "pod-uid" },
				status: { containerStatuses: [{ name: "server", imageID: "sha256:abcd" }] },
			},
		],
	};
	writeFileSync(
		path.join(root, "bin/kubectl"),
		`#!${process.execPath}\nimport fs from 'node:fs'; const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n'); console.log(JSON.stringify(args.includes('deployment') ? ${JSON.stringify(deployment)} : ${JSON.stringify(pods)}));`,
		{ mode: 0o700 },
	);
	vi.stubEnv("PATH", `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`);
	const result = kubernetesEvidence({
		namespace: "custom-namespace",
		deployment: "custom-server",
		kubeconfig: "/selected/config",
		expectedServerImage: "example/server@sha256:abcd",
	});
	expect(result).toMatchObject({
		namespace: "custom-namespace",
		deployment: "custom-server",
		annotations: { "leitwerk.dev/git-sha": "example-sha" },
		serverImageIds: [
			{ pod: "custom-pod", podUid: "pod-uid", name: "server", imageId: "sha256:abcd" },
		],
	});
	for (const line of readFileSync(calls, "utf8").trim().split("\n")) {
		const args = JSON.parse(line);
		expect(args).toContain("get");
		expect(args).toContain("custom-namespace");
		expect(args).toContain("/selected/config");
	}
	expect(() =>
		kubernetesEvidence({
			namespace: "custom-namespace",
			deployment: "custom-server",
			expectedServerImage: "different-image",
		}),
	).toThrow("expected server image");
});
