// biome-ignore-all lint/style/noNonNullAssertion: This throwaway fixture requires identities established by preceding operations and assertions.
// PROTOTYPE executable experiment. Real stores, ProcessEngine, SIGKILL, and containers;
// deterministic model and integration endpoints so this incurs no external writes.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeLlmProvider } from "@leitwerk-dev/test-support";
import { evaluateExport } from "./export.ts";
import type { PrototypeRuntime, RuntimeConfig } from "./runtime.ts";

type State = ReturnType<PrototypeRuntime["state"]>;
type Run = Awaited<ReturnType<PrototypeRuntime["run"]>>;
type History = Awaited<ReturnType<PrototypeRuntime["history"]>>;
type Event = { event: string; data: Record<string, unknown> };
const directory = path.dirname(fileURLToPath(import.meta.url));
const scratch = realpathSync(mkdtempSync("/tmp/leitwerk-pi-durable-"));
const results: { scenario: string; elapsedMs: number; evidence: unknown }[] = [];

class ServerChild {
	readonly child: ChildProcess;
	readonly events: Event[] = [];
	private nextId = 0;
	private stderr = "";
	private pending = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: Error): void }
	>();
	constructor(config: RuntimeConfig) {
		this.child = fork(path.join(directory, "server-main.ts"), [], {
			execArgv: ["--import", "tsx"],
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				PROTOTYPE_MODEL_CREDENTIAL: config.modelCredential,
				PROTOTYPE_EXTERNAL_CREDENTIAL: config.externalCredential,
			},
		});
		this.child.stderr!.on("data", (chunk) => {
			this.stderr += String(chunk);
		});
		this.child.on(
			"message",
			(message: Event & { id?: number; error?: string; result?: unknown }) => {
				if (message.event) {
					this.events.push(message);
					return;
				}
				const pending = this.pending.get(message.id!);
				if (message.error) pending?.reject(new Error(message.error));
				else pending?.resolve(message.result);
				this.pending.delete(message.id!);
			},
		);
		this.child.on("exit", () => {
			for (const p of this.pending.values())
				p.reject(new Error(`Server exited: ${this.stderr.slice(-3000)}`));
			this.pending.clear();
		});
	}
	async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
		const id = ++this.nextId;
		let timer: NodeJS.Timeout;
		try {
			return await Promise.race([
				new Promise<T>((resolve, reject) => {
					this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
					this.child.send({ id, method, args });
				}),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() =>
							reject(
								new Error(
									`${method} timed out: ${this.stderr.slice(-2000)}; events=${JSON.stringify(this.events.slice(-3))}`,
								),
							),
						35_000,
					);
				}),
			]);
		} finally {
			clearTimeout(timer!);
			this.pending.delete(id);
		}
	}
	async event(name: string): Promise<Event> {
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			const event = this.events.find((e) => e.event === name);
			if (event) return event;
			if (this.child.exitCode !== null || this.child.signalCode !== null)
				throw new Error(this.stderr);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error(`No ${name} event: ${this.stderr}; ${JSON.stringify(this.events.slice(-3))}`);
	}
	async kill(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		const exit = once(this.child, "exit");
		this.child.kill("SIGKILL");
		await exit;
	}
	async close(): Promise<void> {
		if (this.child.connected) await this.call("close");
		await this.kill();
	}
}

type Transcript = { messages: { role: string; content: unknown; toolName?: string }[] };
class Fixture {
	readonly config: RuntimeConfig;
	readonly tickets = new Map<string, { id: string; title: string }>();
	readonly model = new FakeLlmProvider();
	readonly requests: Transcript[] = [];
	posts = 0;
	authenticatedModels = 0;
	authenticatedIntegrations = 0;
	server!: Server;
	child!: ServerChild;
	constructor(readonly name: string) {
		const root = path.join(scratch, name);
		mkdirSync(root);
		const workspace = path.join(root, "workspace");
		mkdirSync(workspace);
		chmodSync(workspace, 0o777);
		const state = path.join(root, "server");
		mkdirSync(state, { mode: 0o700 });
		const seed = path.join(root, "seed");
		mkdirSync(seed);
		const git = (...args: string[]) =>
			execFileSync(
				"git",
				["-c", "user.name=Prototype", "-c", "user.email=prototype@example.invalid", ...args],
				{ cwd: seed, stdio: "pipe" },
			);
		git("init", "-b", "main");
		writeFileSync(path.join(seed, "README.md"), "Credential-free prototype fixture\n");
		git("add", ".");
		git("commit", "-m", "fixture");
		git("bundle", "create", path.join(workspace, "seed.bundle"), "--all");
		this.config = {
			directory: state,
			workspace,
			workerName: `leitwerk-durable-${randomUUID()}`,
			providerUrl: "",
			modelCredential: `model-${randomUUID()}`,
			externalCredential: `integration-${randomUUID()}`,
		};
		writeFileSync(
			path.join(state, "credentials.json"),
			JSON.stringify({
				model: this.config.modelCredential,
				integration: this.config.externalCredential,
			}),
			{ mode: 0o600 },
		);
		this.model.onPrompt((serialized) => {
			const request = JSON.parse(serialized) as Transcript;
			this.requests.push(request);
			const user = request.messages.findLastIndex((m) => m.role === "user");
			const prompt = JSON.stringify(request.messages[user]?.content);
			if (prompt.includes("NOTE")) return { content: `Acknowledged ${prompt}` };
			const tail = request.messages.slice(user + 1);
			const used = (name: string) =>
				tail.some((m) => m.role === "toolResult" && m.toolName === name);
			const tool = (name: string, args: Record<string, unknown>) => ({
				content: "",
				toolCalls: [{ name, arguments: args }],
			});
			if (used("finish")) return { content: "Result published." };
			if (prompt.includes("SAFE") && !prompt.includes("UNSAFE") && !used("create_ticket"))
				return tool("create_ticket", { title: "Durable effect" });
			if (prompt.includes("UNSAFE") && !used("unsafe_action")) return tool("unsafe_action", {});
			if (prompt.includes("REVIEW") && !used("bash"))
				return tool("bash", { command: "touch unauthorized-review-write" });
			if (!prompt.includes("REVIEW") && !used("write"))
				return tool("write", {
					path: "draft.md",
					content: prompt.includes("FINAL") ? "Revised plan\n" : "Initial plan\n",
				});
			return tool("finish", {
				markdown: prompt.includes("REVIEW")
					? "Reviewed plan"
					: prompt.includes("FINAL")
						? "Revised plan"
						: "Initial plan",
			});
		});
	}
	async open(fault?: string): Promise<State> {
		if (!this.server) {
			this.server = createServer(async (req, res) => {
				try {
					const model = req.url === "/model";
					if (
						req.headers.authorization !==
						`Bearer ${model ? this.config.modelCredential : this.config.externalCredential}`
					) {
						res.writeHead(401).end();
						return;
					}
					let body = "";
					for await (const chunk of req) body += chunk;
					let result: unknown;
					if (model) {
						this.authenticatedModels++;
						result = this.model.respond(body);
					} else {
						this.authenticatedIntegrations++;
						if (req.method === "POST") {
							const value = JSON.parse(body);
							this.posts++;
							assert(!this.tickets.has(value.key), "Duplicate external side effect");
							result = { id: randomUUID(), title: value.title };
							this.tickets.set(value.key, result as { id: string; title: string });
						} else
							result = this.tickets.get(decodeURIComponent(req.url!.slice("/tickets/".length)));
					}
					res.writeHead(result ? 200 : 404, { "content-type": "application/json" });
					res.end(JSON.stringify(result ?? null));
				} catch (error) {
					res.writeHead(500).end(JSON.stringify({ error: String(error) }));
				}
			});
			this.server.listen(0, "127.0.0.1");
			await once(this.server, "listening");
			this.config.providerUrl = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
		}
		this.child = new ServerChild(this.config);
		return this.child.call<State>("open", { ...this.config, fault });
	}
	async close(): Promise<void> {
		await this.child?.kill();
		try {
			execFileSync("docker", ["rm", "-f", this.config.workerName], { stdio: "ignore" });
		} catch {}
		this.server?.closeAllConnections();
		if (this.server) await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
	publicArtifacts(): void {
		const wire = readFileSync(path.join(this.config.directory, "worker-wire.jsonl"), "utf8");
		const history = JSON.stringify(this.requests);
		const files = readdirSync(this.config.workspace, { recursive: true, withFileTypes: true })
			.filter((e) => e.isFile())
			.map((e) => readFileSync(path.join(e.parentPath, e.name)).toString("utf8"));
		for (const secret of [this.config.modelCredential, this.config.externalCredential]) {
			for (const form of [
				secret,
				Buffer.from(secret).toString("base64"),
				encodeURIComponent(secret),
			]) {
				assert(
					files.every((f) => !f.includes(form)),
					"Credential in worker workspace",
				);
				assert(!wire.includes(form), "Credential in worker wire");
				assert(!history.includes(form), "Credential in model context");
			}
		}
	}
}

async function scenario(name: string, evaluate: (f: Fixture) => Promise<unknown>): Promise<void> {
	const f = new Fixture(name);
	const start = Date.now();
	try {
		const evidence = await evaluate(f);
		f.publicArtifacts();
		results.push({ scenario: name, elapsedMs: Date.now() - start, evidence });
		console.log(`PASS ${name}`);
	} finally {
		await f.close();
	}
}

try {
	await scenario("acceptance-security-branches-watch", async (f) => {
		const initial = await f.open();
		assert.equal(initial.turns.length, 0);
		await assert.rejects(f.child.call("probe", "echo denied"), /Stale or unaccepted/);
		const prepared = await f.child.call<{ conversationId: number; turnRecordId: string }>(
			"prepare",
		);
		await Promise.all([f.child.call("prepare"), f.child.call("prepare")]);
		assert.equal((await f.child.call<State>("state")).turns.length, 1);
		const inspected = await f.child.call<{
			HostConfig: {
				NetworkMode: string;
				ReadonlyRootfs: boolean;
				CapDrop: string[];
				SecurityOpt: string[];
			};
			Mounts: { Source: string; Destination: string }[];
			Config: { User: string; Env: string[] };
		}>("inspectWorker");
		assert.equal(inspected.HostConfig.NetworkMode, "none");
		assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
		assert(inspected.HostConfig.CapDrop.includes("ALL"));
		assert(inspected.HostConfig.SecurityOpt.includes("no-new-privileges"));
		assert.equal(inspected.Config.User, "65534:65534");
		assert.deepEqual(
			inspected.Mounts.map((m) => m.Destination),
			["/workspace"],
		);
		assert.equal(inspected.Mounts[0]!.Source, f.config.workspace);
		await assert.rejects(f.child.call("rejectSecret"), /Credential boundary/);
		const probe = await f.child.call<string>(
			"probe",
			'node -e \'const fs=require("fs"); for(const p of ["/var/run/docker.sock","/root/.pi/agent/auth.json","/root/.aws/credentials"]) { try { fs.readFileSync(p); throw new Error("Readable secret source"); } catch(e) { if(e.message==="Readable secret source") throw e; } } console.log(JSON.stringify(process.env)); console.log(fs.readFileSync("/proc/1/environ","utf8")); console.log("isolation-ok");\' ',
		);
		assert(probe.includes("isolation-ok"));
		await f.child
			.call(
				"probe",
				// Generated URL contains only a fixed hostname, numeric port and fixed path.
				`node -e 'fetch("${f.config.providerUrl.replace("127.0.0.1", "host.docker.internal")}/model",{signal:AbortSignal.timeout(1000)}).then(()=>{process.exitCode=1},()=>console.log("network-blocked"))'`,
			)
			.then((v) => assert(String(v).includes("network-blocked")));
		await f.child.call("watch", prepared.conversationId, "live");
		const plan = await f.child.call<Run>("run", "PLAN");
		assert.equal(plan.state.process.selectedTurnId, "review");
		assert.deepEqual(await f.child.call("outcome", plan.payload), { duplicate: true });
		const watchFrames = f.child.events.filter((e) => e.event === "view").length;
		assert(watchFrames > 0);
		const oldView = await f.child.call("view", prepared.conversationId);
		await f.child.kill();
		await f.open();
		assert.deepEqual(await f.child.call("view", prepared.conversationId), oldView);
		const reviewPrepared = await f.child.call<{ conversationId: number }>("prepare");
		await assert.rejects(
			f.child.call("checkTool", reviewPrepared.conversationId, "bash"),
			/not authorized/,
		);
		const review = await f.child.call<Run>("run", "REVIEW");
		assert.equal(review.state.process.selectedTurnId, "revise");
		const final = await f.child.call<Run>("run", "FINAL");
		assert.equal(final.state.process.lifecycleStatus, "completed");
		const history = await f.child.call<History>("history");
		assert.equal(history.conversations.length, 2);
		assert.equal(
			history.conversations.find((c) => c.id === review.conversationId)?.parent?.at,
			Number(plan.payload.resultPiEntryId!.slice(1)),
		);
		const primary = history.conversations.find((c) => c.id === plan.conversationId)!;
		assert(
			!JSON.stringify(primary.entries).includes("Reviewed plan"),
			"Review leaked into primary context",
		);
		const refs = JSON.parse(final.state.process.stateJson!).productRefs;
		assert.deepEqual(Object.keys(refs).sort(), ["final", "plan", "review"]);
		assert.equal(refs.plan.entryId, plan.payload.resultPiEntryId);
		assert.equal(refs.review.entryId, review.payload.resultPiEntryId);
		assert.equal(refs.final.entryId, final.payload.resultPiEntryId);
		assert.equal(final.state.turns.length, 3);
		assert(final.state.turns.every((t) => t.attemptNumber === 1));
		assert(
			f.requests.every((r) =>
				JSON.stringify(r.messages.filter((m) => m.role === "system")).includes(
					"Managed prototype instructions v1",
				),
			),
		);
		assert.equal(
			readFileSync(path.join(f.config.workspace, "repo/draft.md"), "utf8"),
			"Revised plan\n",
		);
		assert.throws(() =>
			readFileSync(path.join(f.config.workspace, "repo/unauthorized-review-write")),
		);
		writeFileSync(path.join(scratch, "happy-history.json"), JSON.stringify(history, null, 2));
		const exportResult = await evaluateExport(
			history,
			f.config.workspace,
			f.config.directory,
			final.state.process.id,
		);
		return {
			exportResult,
			attempts: final.state.turns.length,
			conversations: history.conversations.length,
			authenticatedModelCalls: f.authenticatedModels,
			watchFrames,
		};
	});
	for (const fault of [
		"after_acceptance",
		"after_binding",
		"during_model",
		"after_external_effect",
		"during_unsafe_tool",
		"before_business_outcome",
		"after_business_outcome",
	]) {
		await scenario(fault, async (f) => {
			await f.open(fault);
			const prompt =
				fault === "after_external_effect"
					? "SAFE"
					: fault === "during_unsafe_tool"
						? "UNSAFE"
						: "PLAN";
			const pending = f.child.call("run", prompt).catch(() => undefined);
			await f.child.event("fault");
			const before = await f.child.call<State>("state");
			await f.child.kill();
			await pending;
			const reopened = await f.open();
			if (reopened.process.selectedTurnId === "primary") await f.child.call("run", prompt);
			const after = await f.child.call<State>("state");
			assert.equal(after.process.selectedTurnId, "review");
			assert.equal(after.turns.length, 1);
			assert.equal(after.turns[0]!.attemptNumber, 1);
			assert.equal(after.turns[0]!.id, before.turns[0]!.id);
			const history = await f.child.call<History>("history");
			const userEntries = history.conversations[0]!.entries.filter((e) =>
				e.model?.some((m) => m.role === "user"),
			);
			assert.equal(userEntries.length, 1, "Input was duplicated after restart");
			if (fault === "after_external_effect") {
				assert.equal(f.posts, 1);
				assert.equal(f.tickets.size, 1);
			}
			if (fault === "during_unsafe_tool") {
				assert.equal(
					readFileSync(path.join(f.config.workspace, "repo/unsafe-effects.txt"), "utf8"),
					"unsafe-effect\n",
				);
				assert(
					JSON.stringify(history).includes("interrupted"),
					"Unsafe tool needs an interrupted result",
				);
			}
			return {
				attempts: after.turns.length,
				inputEntries: userEntries.length,
				externalEffects: f.posts,
				selectedTurn: after.process.selectedTurnId,
			};
		});
	}
	await scenario("stop-retry-stale-fencing", async (f) => {
		await f.open("during_model");
		const pending = f.child.call("run", "PLAN").catch(() => undefined);
		await f.child.event("fault");
		const old = (await f.child.call<State>("state")).record!;
		await f.child.call("stop");
		await pending;
		const stopped = await f.child.call<State>("state");
		assert.equal(stopped.process.lifecycleStatus, "error");
		assert.equal(stopped.process.selectedTurnId, "primary");
		await f.child.kill();
		await f.open();
		await f.child.call("retry");
		const prepared = await f.child.call<{ turnRecordId: string }>("prepare");
		assert.notEqual(prepared.turnRecordId, old.id);
		await assert.rejects(f.child.call("probe", "touch stale-worker-write", old.id), /Stale/);
		await assert.rejects(
			f.child.call("outcome", {
				instanceId: old.instanceId,
				turnRecordId: old.id,
				turnId: old.turnId,
				turnType: "llm",
				outcome: "done",
				params: {},
				pathType: old.pathType,
				forkPiEntryId: null,
				resultPiEntryId: "stale",
				turnResultMarkdown: "stale",
			}),
			/stale|Stale/,
		);
		const result = await f.child.call<Run>("run", "PLAN");
		assert.equal(result.state.turns.length, 2);
		assert.equal(result.state.turns.find((t) => t.id === prepared.turnRecordId)?.attemptNumber, 2);
		return { attempts: 2, selectedTurn: result.state.process.selectedTurnId, staleRejected: true };
	});
	await scenario("stop-with-pending-outcome", async (f) => {
		await f.open("before_business_outcome");
		const pending = f.child.call("run", "PLAN").catch(() => undefined);
		await f.child.event("fault");
		const history = await f.child.call<History>("history");
		const payload = JSON.parse(Object.values(history.index!.receipts)[0]!.payload);
		await f.child.call("stop");
		await assert.rejects(f.child.call("outcome", payload), /Stale/);
		await f.child.kill();
		await pending;
		const reopened = await f.open();
		assert.equal(reopened.process.lifecycleStatus, "error");
		assert.equal(reopened.process.selectedTurnId, "primary");
		assert.equal(reopened.turns[0]?.status, "failed");
		const recoveredHistory = await f.child.call<History>("history");
		assert(Object.values(recoveredHistory.index!.receipts)[0]!.discarded);
		return { staleOutcomeRejected: true, pendingReceiptDiscarded: true };
	});
	await scenario("queued-inputs-reconnect", async (f) => {
		await f.open("during_model");
		const first = await f.child.call<{ id: number; conversationId: number }>(
			"submitInput",
			"NOTE FIRST",
			"first",
		);
		await f.child.event("fault");
		const second = await f.child.call<{ id: number; status: string }>(
			"submitInput",
			"NOTE SECOND",
			"second",
		);
		assert.equal(second.status, "queued");
		assert.equal(
			(await f.child.call<{ id: number }>("submitInput", "NOTE SECOND", "second")).id,
			second.id,
		);
		const view = await f.child.call("view", first.conversationId);
		await f.child.kill();
		await f.open();
		assert.deepEqual(await f.child.call("view", first.conversationId), view);
		assert.equal((await f.child.call<{ status: string }>("awaitInput", first.id)).status, "done");
		assert.equal((await f.child.call<{ status: string }>("awaitInput", second.id)).status, "done");
		const history = await f.child.call<History>("history");
		const inputs = history.conversations[0]!.entries.filter((e) =>
			e.model?.some((m) => m.role === "user"),
		).reverse();
		assert.equal(inputs.length, 2);
		assert(JSON.stringify(inputs[0]).includes("NOTE FIRST"));
		assert(JSON.stringify(inputs[1]).includes("NOTE SECOND"));
		assert.equal((await f.child.call<State>("state")).turns.length, 1);
		return { queuedRecovered: true, duplicateSubmissionId: second.id, inputEntries: inputs.length };
	});
	const report = {
		piDurable: "1.0.2",
		node: process.version,
		evaluatedAt: new Date().toISOString(),
		scratch,
		results,
	};
	mkdirSync(path.join(directory, "../results"), { recursive: true });
	writeFileSync(
		path.join(directory, "../results/evaluation.json"),
		JSON.stringify(report, null, 2),
	);
	console.log(JSON.stringify(report, null, 2));
} catch (error) {
	console.error(error);
	console.error(`Scratch evidence: ${scratch}`);
	process.exitCode = 1;
}
