import fs from "node:fs";
import path from "node:path";
import type { Snapshot, Source } from "../src/model";

/** @internal Portable versioned report envelope. */
export interface Report {
	schemaVersion: 1;
	producerVersion: string;
	kind: "catalog" | "usage" | "supplemental";
	source: { id: string; name: string; revision: string; fingerprint: string };
	analyzedPackages: Record<string, string>;
	snapshot: Snapshot;
	keep?: { target: string; reason: string }[];
}
function validSource(value: Source): boolean {
	return (
		!!value &&
		typeof value.path === "string" &&
		typeof value.snippet === "string" &&
		Number.isInteger(value.line) &&
		Number.isInteger(value.column)
	);
}
const strings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((v) => typeof v === "string");
function valid(value: unknown): value is Report {
	if (!value || typeof value !== "object") return false;
	const r = value as Report;
	return (
		r.schemaVersion === 1 &&
		typeof r.producerVersion === "string" &&
		["catalog", "usage", "supplemental"].includes(r.kind) &&
		typeof r.source?.id === "string" &&
		typeof r.source.name === "string" &&
		typeof r.source.fingerprint === "string" &&
		!!r.analyzedPackages &&
		Object.values(r.analyzedPackages).every((v) => typeof v === "string") &&
		r.snapshot?.version === 1 &&
		!!r.snapshot.coverage &&
		typeof r.snapshot.coverage.complete === "boolean" &&
		strings(r.snapshot.coverage.limitations) &&
		typeof r.snapshot.coverage.sourceFiles === "number" &&
		typeof r.snapshot.coverage.entryPoints === "number" &&
		typeof r.snapshot.coverage.extractedEntryPoints === "number" &&
		typeof r.snapshot.generatedAt === "string" &&
		typeof r.snapshot.repository?.id === "string" &&
		typeof r.snapshot.repository.revision === "string" &&
		[
			r.snapshot.nodes,
			r.snapshot.occurrences,
			r.snapshot.relationships,
			r.snapshot.diagnostics,
		].every(Array.isArray) &&
		r.snapshot.nodes.every(
			(n) =>
				typeof n.id === "string" &&
				typeof n.kind === "string" &&
				typeof n.package === "string" &&
				typeof n.label === "string" &&
				(n.source === undefined || validSource(n.source)) &&
				(n.signatures === undefined || strings(n.signatures)) &&
				(n.keepReasons === undefined || strings(n.keepReasons)) &&
				(n.entry === undefined || typeof n.entry === "string") &&
				(n.evidence === undefined ||
					(Array.isArray(n.evidence) &&
						n.evidence.every(
							(e) =>
								typeof e.kind === "string" &&
								typeof e.label === "string" &&
								typeof e.detail === "string" &&
								validSource(e.source),
						))),
		) &&
		r.snapshot.occurrences.every(
			(o) =>
				typeof o.id === "string" &&
				typeof o.fileId === "string" &&
				validSource(o) &&
				["call", "type", "other", "import", "re-export"].includes(o.kind) &&
				(o.routeTargets === undefined || strings(o.routeTargets)) &&
				Array.isArray(o.targets) &&
				o.targets.every((t) => typeof t === "string"),
		) &&
		r.snapshot.relationships.every(
			(edge) =>
				typeof edge.from === "string" &&
				typeof edge.to === "string" &&
				typeof edge.kind === "string",
		) &&
		r.snapshot.diagnostics.every(
			(d) =>
				typeof d.scope === "string" &&
				typeof d.message === "string" &&
				typeof d.severity === "string",
		) &&
		(r.keep === undefined ||
			(Array.isArray(r.keep) &&
				r.keep.every((k) => typeof k.target === "string" && typeof k.reason === "string")))
	);
}
/** @internal Read only JSON children of the configured report directory. */
export function loadReports(directory: string): Snapshot {
	const diagnostics: Snapshot["diagnostics"] = [];
	const reports: { file: string; report: Report }[] = [];
	for (const file of fs.existsSync(directory) ? fs.readdirSync(directory).sort() : []) {
		if (!file.endsWith(".json")) continue;
		try {
			if (!fs.lstatSync(path.join(directory, file)).isFile()) continue;
			const value: unknown = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
			if (!valid(value))
				throw new Error("Malformed report or incompatible schema; regenerate with api:report.");
			reports.push({ file, report: value });
		} catch (error) {
			diagnostics.push({ severity: "warning", scope: file, message: String(error) });
		}
	}
	const catalog = reports.find(
		(r) => r.file === "catalog.json" && r.report.kind === "catalog",
	)?.report;
	if (!catalog)
		return {
			version: 1,
			repository: { id: "empty", name: "Reports", revision: "unknown", dirty: false },
			generatedAt: new Date().toISOString(),
			coverage: {
				complete: false,
				sourceFiles: 0,
				entryPoints: 0,
				extractedEntryPoints: 0,
				typescriptVersion: "",
				limitations: [
					"No catalog loaded. Run npm run api:report in Leitwerk, then Reload reports.",
				],
			},
			nodes: [],
			occurrences: [],
			relationships: [],
			diagnostics: [
				...diagnostics,
				{
					severity: "warning",
					scope: "catalog.json",
					message:
						"Missing catalog. Run npm run api:report in Leitwerk; collect usage-*.json here, then Reload reports.",
				},
			],
			reports: [],
		};
	const result = structuredClone(catalog.snapshot);
	result.reports = [];
	result.reportLoadingIncomplete = diagnostics.length > 0;
	result.diagnostics.push(...diagnostics);
	const nodes = new Map(result.nodes.map((n) => [n.id, n]));
	const seen = new Set<string>();
	const selected = new Map<string, Report>();
	// Same-source copies never count as additional consumers. Choose newest deterministically.
	for (const { report } of reports
		.filter((r) => r.report.kind !== "catalog")
		.sort((a, b) => a.report.snapshot.generatedAt.localeCompare(b.report.snapshot.generatedAt)))
		selected.set(report.source.id, report);
	selected.delete(catalog.source.id);
	for (const report of [catalog, ...selected.values()]) {
		const matching = Object.entries(report.analyzedPackages).every(
			([name, version]) =>
				!catalog.analyzedPackages[name] || catalog.analyzedPackages[name] === version,
		);
		result.reports.push({
			...report.source,
			producerVersion: report.producerVersion,
			analyzedPackages: report.analyzedPackages,
			compatible: matching,
			complete:
				matching &&
				report.snapshot.coverage.complete &&
				report.snapshot.coverage.sourceFiles > 0 &&
				(report.kind === "catalog" || report.snapshot.occurrences.length > 0),
		});
		if (!matching)
			result.diagnostics.push({
				severity: "warning",
				scope: report.source.name,
				message:
					"Package versions differ. Matched positive evidence is included; this report cannot establish absence of consumers.",
			});
		if (report !== catalog) {
			result.diagnostics.push(...report.snapshot.diagnostics);
			result.coverage.sourceFiles += report.snapshot.coverage.sourceFiles;
			for (const node of report.snapshot.nodes.filter((n) => n.kind === "file")) {
				const copy = { ...node, id: `${report.source.id}:${node.id}` };
				nodes.set(copy.id, copy);
			}
			for (const item of report.snapshot.occurrences) {
				const targets = item.targets.filter((id) => nodes.has(id));
				if (targets.length !== item.targets.length)
					result.diagnostics.push({
						severity: "warning",
						scope: report.source.name,
						message: `Unmatched symbol at ${item.path}:${item.line}`,
					});
				if (!targets.length) continue;
				const key = `${report.source.id}:${item.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				result.occurrences.push({
					...item,
					id: key,
					fileId: `${report.source.id}:${item.fileId}`,
					targets,
					reportId: report.source.id,
				});
			}
			for (const node of report.snapshot.nodes) {
				const target = nodes.get(node.id);
				if (target && node.evidence)
					target.evidence = [
						...(target.evidence ?? []),
						...node.evidence.map((e) => ({ ...e, reportId: report.source.id })),
					];
			}
		}
		for (const keep of report.keep ?? []) {
			const target = nodes.get(keep.target);
			if (target) {
				target.keepReasons ??= [];
				target.keepReasons.push(`${report.source.name}: ${keep.reason}`);
			} else
				result.diagnostics.push({
					severity: "warning",
					scope: report.source.name,
					message: `Unmatched keep target: ${keep.target}`,
				});
		}
	}
	result.nodes = [...nodes.values()];
	result.occurrences = [
		...new Map(
			result.occurrences.map((o) => [
				`${o.reportId ?? catalog.source.id}:${o.id}`,
				{ ...o, reportId: o.reportId ?? catalog.source.id },
			]),
		).values(),
	];
	result.coverage.complete =
		diagnostics.length === 0 &&
		result.reports.every((r) => r.complete) &&
		!result.diagnostics.some((d) => d.severity === "error" || d.message.startsWith("Unmatched"));
	return result;
}
