import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { expected, fixture } from "./test-fixture.ts";

it.each([
	false,
	true,
])("runs the canary through physical replacement and detects changed retained storage (%s)", (replaceStorage) => {
	const root = mkdtempSync(path.join(tmpdir(), "leitwerk-docker-canary-"));
	const bin = path.join(root, "bin");
	mkdirSync(bin);
	const callsFile = path.join(root, "calls.jsonl");
	const stateFile = path.join(root, "state.json");
	const evidence = path.join(root, "evidence");
	writeFileSync(
		path.join(bin, "kubectl"),
		`#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
const stateFile = ${JSON.stringify(stateFile)};
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : {generation:0, live:false, marker:''};
const input = args.includes('apply') || args.includes('build') ? fs.readFileSync(0,'utf8') : '';
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({args,input})+'\\n');
const persist = () => fs.writeFileSync(stateFile,JSON.stringify(state));
const reply = value => console.log(typeof value === 'string' ? value : JSON.stringify(value));
if (args.includes('create')) { persist(); }
else if (args.includes('apply')) {
 if (input.includes('kind: Pod')) {
  if (state.live) throw new Error('Replacement started before deletion');
  state.generation++; state.live=true; persist();
 }
}
else if (args.includes('delete')) { if(args.includes('pod')) {state.live=false; persist();} }
else if (args.includes('wait')) { if(args.includes('--for=delete') && state.live) throw new Error('Pod still exists'); }
else if (args.includes('get')) {
 const {pod,pvc,pv} = ${JSON.stringify(fixture())};
 pod.metadata.name='docker-canary'; pod.metadata.namespace='fixture-canary'; pod.metadata.uid='pod-'+state.generation;
 pod.spec.volumes[0].persistentVolumeClaim.claimName='docker-state';
 pvc.metadata.name='docker-state'; pvc.metadata.namespace='fixture-canary'; pv.spec.claimRef.name='docker-state'; pv.spec.claimRef.namespace='fixture-canary';
 if (${replaceStorage} && state.generation>1) {pvc.metadata.uid='other-pvc'; pv.spec.claimRef.uid='other-pvc';}
 if(args.includes('pod')) reply(pod);
 else if(args.includes('pvc')) reply(args.some(a=>a.includes('jsonpath=')) ? 'pv-a' : pvc);
 else if(args.includes('pv')) reply(pv);
 else throw new Error('Unexpected get');
}
else if (args.includes('exec')) {
 if(args.includes('docker') && args.includes('info')) reply(args.includes('{{.Driver}}') ? 'overlay2' : {Driver:'overlay2',DockerRootDir:'/state/tooling/docker',ServerVersion:'example-version'});
 else if(args.includes('docker') && args.includes('inspect')) reply('sha256:'+'a'.repeat(64));
 else if(args.includes('node') && args.some(a=>a.includes('randomUUID'))) { state.marker='retained-workspace'; persist(); }
 else if(args.includes('node')) reply([8080]);
 else if(args.includes('cat')) reply(state.marker);
}
else throw new Error('Unexpected kubectl call: '+args.join(' '));
`,
		{ mode: 0o700 },
	);
	try {
		const result = spawnSync(
			"/bin/bash",
			[path.resolve("scripts/docker-runtime/test-kubernetes-runner.sh")],
			{
				encoding: "utf8",
				timeout: 30_000,
				env: {
					...process.env,
					PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
					LEITWERK_WORKER_IMAGE: expected.workerImage,
					LEITWERK_RUNTIME_CLASS_NAME: expected.runtimeClass,
					LEITWERK_DOCKER_STORAGE_CLASS_NAME: expected.storageClass,
					LEITWERK_DOCKER_TEST_NAMESPACE: "fixture-canary",
					LEITWERK_DOCKER_EVIDENCE_DIR: evidence,
				},
			},
		);
		expect(result.status, result.stdout + result.stderr).toBe(replaceStorage ? 1 : 0);
		const before = JSON.parse(readFileSync(path.join(evidence, "before/evidence.json"), "utf8"));
		expect(before).toMatchObject({
			podUid: "pod-1",
			pvcUid: "pvc-1",
			marker: "retained-workspace",
		});
		if (replaceStorage) expect(result.stderr).toContain("Replacement did not retain pvcUid");
		else {
			const after = JSON.parse(readFileSync(path.join(evidence, "after/evidence.json"), "utf8"));
			expect(after).toMatchObject({
				podUid: "pod-2",
				pvcUid: "pvc-1",
				replacesPodUid: "pod-1",
				innerImageId: before.innerImageId,
				workerImageId: before.workerImageId,
				marker: before.marker,
			});
			expect(after.previousPodDeletedAt).toBeDefined();
			expect(statSync(path.join(evidence, "after/evidence.json")).mode & 0o777).toBe(0o600);
		}
		const calls = readFileSync(callsFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { args: string[]; input: string });
		const podStarts = calls.flatMap((call, index) =>
			call.input.includes("kind: Pod") ? [index] : [],
		);
		const deletion = calls.findIndex(
			(call) => call.args.includes("delete") && call.args.includes("pod"),
		);
		const confirmed = calls.findIndex((call) => call.args.includes("--for=delete"));
		expect(podStarts).toHaveLength(2);
		expect(deletion).toBeGreaterThan(podStarts[0]);
		expect(confirmed).toBeGreaterThan(deletion);
		expect(podStarts[1]).toBeGreaterThan(confirmed);
		expect(calls.at(-1)?.args).toContain("namespace");
		expect(calls.at(-1)?.args).toContain("delete");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 40_000);
