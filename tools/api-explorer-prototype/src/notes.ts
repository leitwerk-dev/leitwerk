import type { ApiNode, Snapshot } from "./model";
/** @internal */
export interface Note {
	nodeId: string;
	text: string;
	modifiedAt: string;
	context: Pick<ApiNode, "label" | "package" | "kind" | "entry" | "qualifiedName" | "source">;
}
/** @internal */
export interface Backup {
	version: 1;
	repositoryId: string;
	notes: Record<string, Note>;
}
/** @internal One clear operation can be undone without replacing later edits. */
export interface NoteClearUndo {
	previous: Record<string, Note>;
	cleared: Record<string, Note>;
}
const after = (now: string, previous: string) =>
	new Date(Math.max(Date.parse(now), Date.parse(previous) + 1)).toISOString();
/** @internal Clearing retains deletion timestamps, including for hidden and absent nodes. */
export function clearNotes(
	notes: Record<string, Note>,
	ids = Object.keys(notes),
	now = new Date().toISOString(),
) {
	const next = { ...notes };
	const undo: NoteClearUndo = { previous: {}, cleared: {} };
	for (const id of ids) {
		const note = notes[id];
		if (!note?.text) continue;
		undo.previous[id] = note;
		undo.cleared[id] = { ...note, text: "", modifiedAt: after(now, note.modifiedAt) };
		next[id] = undo.cleared[id];
	}
	return { notes: next, undo };
}
/** @internal Undo only notes that are still unchanged since the clear. */
export function undoNoteClear(
	notes: Record<string, Note>,
	undo: NoteClearUndo,
	now = new Date().toISOString(),
) {
	const next = { ...notes };
	for (const [id, previous] of Object.entries(undo.previous)) {
		const current = notes[id];
		if (current?.text === "" && current.modifiedAt === undo.cleared[id].modifiedAt)
			next[id] = { ...previous, modifiedAt: after(now, current.modifiedAt) };
	}
	return next;
}
/** @internal */
export const storageKey = (repositoryId: string) => `leitwerk-api-notes:v1:${repositoryId}`;
/** @internal Validate before changing stored notes; wrong repositories never merge. */
export function parseBackup(text: string, repositoryId: string): Backup {
	const value = JSON.parse(text);
	if (
		!value ||
		value.version !== 1 ||
		value.repositoryId !== repositoryId ||
		!value.notes ||
		typeof value.notes !== "object" ||
		Array.isArray(value.notes)
	)
		throw new Error(
			"Unsupported backup or different repository. Import a version 1 backup for this repository.",
		);
	for (const [id, n] of Object.entries(value.notes) as [string, Note][]) {
		if (
			!n ||
			["__proto__", "constructor", "prototype"].includes(id) ||
			n.nodeId !== id ||
			typeof n.text !== "string" ||
			typeof n.modifiedAt !== "string" ||
			!Number.isFinite(Date.parse(n.modifiedAt)) ||
			!n.context ||
			["label", "package", "kind"].some(
				(k) => typeof n.context[k as keyof Note["context"]] !== "string",
			)
		)
			throw new Error(`Invalid note: ${id}`);
		for (const key of ["entry", "qualifiedName"] as const)
			if (n.context[key] !== undefined && typeof n.context[key] !== "string")
				throw new Error(`Invalid context: ${id}`);
		const source = n.context.source;
		if (
			source &&
			(typeof source.path !== "string" ||
				typeof source.snippet !== "string" ||
				!Number.isInteger(source.line) ||
				source.line < 1 ||
				!Number.isInteger(source.column) ||
				source.column < 1)
		)
			throw new Error(`Invalid source: ${id}`);
	}
	return value;
}
/** @internal Empty notes remain as tombstones, so older backups cannot resurrect deletions. */
export function mergeNotes(current: Record<string, Note>, incoming: Record<string, Note>) {
	const merged = { ...current };
	for (const [id, note] of Object.entries(incoming))
		if (!merged[id] || Date.parse(note.modifiedAt) > Date.parse(merged[id].modifiedAt))
			merged[id] = note;
	return merged;
}
/** @internal */
export function makeNote(node: ApiNode, text: string, now = new Date().toISOString()): Note {
	const { label, package: pkg, kind, entry, qualifiedName, source } = node;
	return {
		nodeId: node.id,
		text,
		modifiedAt: now,
		context: { label, package: pkg, kind, entry, qualifiedName, source },
	};
}
/** @internal */
export function markdownExport(notes: Record<string, Note>, snapshot: Snapshot): string {
	const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
	const safe = (text: string) => text.replace(/[\r\n]/g, " ").replace(/[\\`*_{}[\]<>#]/g, "\\$&");
	const output = [
		`# ${safe(snapshot.repository.name)} API notes`,
		"",
		`Snapshot: ${snapshot.repository.revision}`,
		`Indexed: ${snapshot.generatedAt}`,
		"",
	];
	let pkg = "";
	for (const note of Object.values(notes)
		.filter((n) => n.text.trim())
		.sort(
			(a, b) =>
				a.context.package.localeCompare(b.context.package) || a.nodeId.localeCompare(b.nodeId),
		)) {
		const node = byId.get(note.nodeId) ?? note.context;
		if (node.package !== pkg) {
			pkg = node.package;
			output.push(`## ${safe(pkg)}`, "");
		}
		output.push(
			`### ${safe(node.qualifiedName ?? node.label)}`,
			"",
			`Identity: ${safe(note.nodeId)}`,
			`Kind: ${safe(node.kind)}${node.entry ? ` · Entry: ${safe(node.entry)}` : ""}`,
		);
		if (node.source) output.push(`Source: ${safe(node.source.path)}:${node.source.line}`);
		if (!byId.has(note.nodeId)) output.push("Absent from the current snapshot.");
		output.push("", note.text, "");
	}
	return output.join("\n");
}
