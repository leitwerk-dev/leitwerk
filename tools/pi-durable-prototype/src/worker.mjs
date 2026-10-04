// PROTOTYPE. This is the entire worker: no models, integration clients, credentials,
// server configuration, database, or dynamic extension loader.
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const env = new NodeExecutionEnv({ cwd: "/workspace/repo" });
const active = new Map();
const readers = new Map();
const methods = new Set([
	"absolutePath",
	"joinPath",
	"readTextFile",
	"readTextLines",
	"readBinaryFile",
	"writeFile",
	"appendFile",
	"truncateFile",
	"flushFile",
	"renameFile",
	"fileInfo",
	"listDir",
	"canonicalPath",
	"exists",
	"createDir",
	"remove",
	"createTempDir",
	"createTempFile",
	"openTextLineReader",
	"exec",
	"reader.read",
	"reader.close",
]);
function encode(_key, value) {
	if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
	if (value instanceof Error) return { name: value.name, message: value.message, code: value.code };
	return value;
}
function decode(_key, value) {
	return value?.$bytes === undefined ? value : Uint8Array.from(Buffer.from(value.$bytes, "base64"));
}
function send(message) {
	process.stdout.write(`${JSON.stringify(message, encode)}\n`);
}
async function dispatch(request) {
	const { id, method } = request;
	if (method === "cancel") {
		active.get(request.target)?.abort();
		return;
	}
	if (!methods.has(method)) throw new Error("Unsupported worker operation");
	const controller = new AbortController();
	active.set(id, controller);
	const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
	try {
		const args = request.args;
		let result;
		if (method === "exec") {
			// No caller-supplied environment: a model cannot ask the server to forward
			// provider credentials through shell options.
			const options = args[1] ?? {};
			if (options.env !== undefined || options.inheritEnv !== undefined) {
				throw new Error("Shell environment overrides are forbidden");
			}
			result = await env.exec(
				args[0],
				{
					...options,
					inheritEnv: false,
					env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" },
					onOutput: (text) => send({ id, output: text }),
				},
				context,
			);
		} else if (method === "openTextLineReader") {
			const opened = await env.openTextLineReader(args[0], context);
			if (opened.ok) {
				readers.set(id, opened.value);
				result = { ok: true, value: id };
			} else result = opened;
		} else if (method === "reader.read") {
			result = await readers.get(args[0]).readLine(context);
		} else if (method === "reader.close") {
			await readers.get(args[0])?.close(context);
			readers.delete(args[0]);
		} else {
			result = await env[method](...args, context);
		}
		send({ id, result });
	} finally {
		active.delete(id);
	}
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	let request;
	try {
		request = JSON.parse(line, decode);
	} catch {
		send({ error: "Invalid worker request" });
		return;
	}
	void dispatch(request).catch(() => send({ id: request.id, error: "Worker operation failed" }));
});
lines.on("close", () => {
	for (const controller of active.values()) controller.abort();
	void env.cleanup(BACKGROUND_CONTEXT).finally(() => process.exit(0));
});
send({ ready: true });
