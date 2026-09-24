import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { testWorkspace } from "../test-workspace.js";
import { kubernetesEvidence } from "./benchmark-kubernetes.js";

afterEach(() => vi.unstubAllEnvs());
it("captures a selected deployment without local Git and rejects a different image", () => {
	const { root } = testWorkspace();
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
		deploymentUid: "deployment-uid",
		serverImages: [{ name: "server", image: "example/server@sha256:abcd" }],
		serverImageIds: [
			{ pod: "custom-pod", podUid: "pod-uid", name: "server", imageId: "sha256:abcd" },
		],
	});
	expect(result).toHaveProperty("annotations", { "leitwerk.dev/git-sha": "example-sha" });
	const requests: string[][] = readFileSync(calls, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(requests).toHaveLength(2);
	const deploymentRequest = requests.find((args) => args.includes("deployment"));
	expect(deploymentRequest?.[deploymentRequest.indexOf("deployment") + 1]).toBe("custom-server");
	const podRequest = requests.find((args) => args.includes("pods"));
	expect(podRequest?.[podRequest.indexOf("-l") + 1]).toBe("app=custom-server");
	for (const args of requests) {
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
