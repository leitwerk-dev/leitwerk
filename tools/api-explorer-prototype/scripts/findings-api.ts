import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	absenceBlocked,
	assessmentLabels,
	changeLabels,
	constraintLabels,
	removalCandidates,
} from "../src/candidates";
import {
	filterFindings,
	findingRecord,
	findingsExportParts,
	type FindingFilters,
} from "../src/findings-export";
import type { Snapshot } from "../src/model";

const prefix = "/api/v1/";
const filterKeys = ["query", "change", "assessment", "constraint", "package", "scope"] as const;
const scopes = [
	"file-local-production",
	"file-local-tests",
	"same-package-production",
	"same-package-tests",
	"cross-package-production",
	"cross-package-tests",
	"unknown-package-production",
	"unknown-package-tests",
	"only-test-consumers-observed",
	"no-consumers-observed",
];
const enums = {
	change: Object.keys(changeLabels),
	assessment: Object.keys(assessmentLabels),
	constraint: Object.keys(constraintLabels),
	scope: scopes,
};
class RequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}
const badRequest = (message: string): never => {
	throw new RequestError(400, "invalid-request", message);
};
function parameters(url: URL, allowed: readonly string[]) {
	for (const key of url.searchParams.keys()) {
		if (!allowed.includes(key)) badRequest(`Unknown parameter: ${key}`);
		if (url.searchParams.getAll(key).length !== 1) badRequest(`Duplicate parameter: ${key}`);
	}
}
function filtersFor(url: URL): FindingFilters {
	for (const [key, values] of Object.entries(enums)) {
		const value = url.searchParams.get(key);
		if (value !== null && !values.includes(value))
			badRequest(`Invalid ${key}. Allowed: ${values.join(", ")}`);
	}
	return Object.fromEntries(
		filterKeys.flatMap((key) =>
			url.searchParams.has(key) ? [[key, url.searchParams.get(key)!]] : [],
		),
	);
}
/** @internal Hash content incrementally; avoid serializing a potentially huge snapshot as one string. */
export function analysisIdentity(snapshot: Snapshot): string {
	const hash = createHash("sha256").update("findings-classifier-v2\n");
	for (const key of Object.keys(snapshot).sort() as (keyof Snapshot)[]) {
		// An empty report directory gets a fresh load timestamp, not fresh evidence.
		if (key === "generatedAt") continue;
		hash.update(key).update("\n");
		const value = snapshot[key];
		for (const item of Array.isArray(value) ? value : [value])
			hash.update(JSON.stringify(item) ?? "null").update("\n");
	}
	return hash.digest("hex");
}
const schema = {
	schemaVersion: 1,
	endpoints: {
		"GET /api/v1/findings": {
			parameters: [...filterKeys, "limit", "cursor", "analysisId"],
			response: "ListEnvelope",
		},
		"GET /api/v1/findings/detail": { parameters: ["id", "analysisId"], response: "DetailEnvelope" },
		"GET /api/v1/findings/summary": {
			parameters: [...filterKeys, "analysisId"],
			response: "SummaryEnvelope",
		},
		"GET /api/v1/findings/export": {
			parameters: [...filterKeys, "analysisId"],
			response: "ExportV2",
		},
		"GET /api/v1/schema": { parameters: [], response: "This contract" },
	},
	enums,
	labels: { change: changeLabels, assessment: assessmentLabels, constraint: constraintLabels },
	contracts: {
		common:
			"JSON; schemaVersion=1, analysisId, coverage (scope=loaded-sources), repository, reports. All filters use AND; enum/package/scope filters are exact; query is case-insensitive name/package/action/assessment substring. Filtering never limits analysis.",
		ListEnvelope:
			"Common fields plus total, filters, nextCursor (opaque string|null), findings (FindingSummary[]). Stable binary finding-ID order. limit: integer 1..200, default 50. Cursor pins analysis and filters; changed evidence or filters returns 409. Page size may change.",
		FindingSummary:
			"id, name, package, declaringPackage, source ({path,line,column}|null), proposedChange, assessment, declarationAssessment, observedUsage[], retainingApiIds[], constraints[], routes[]. Full source snippets and occurrence evidence are in detail/export.",
		Constraint:
			"code (constraint enum), appliesTo (package-exposure|module-export|declaration-deletion), detail, optional routeId and ownerIds[]. Multiple constraints can coexist. Retaining one route does not retain every alias.",
		Route:
			"id, package, entry, used, productionUsed, testUsed, assessment, action (display label), constraints[], migrationRequirements[]. Each migration has code (rewrite-same-package-imports|preserve-module-access|separate-entry-facade), occurrenceIds[], detail.",
		DetailEnvelope:
			"Common fields plus finding (ExportFinding), occurrences[], retainingApis[] ({id,node|null}), wiring[] ({routeId,evidence[],keepReasons[]}). Unknown retaining owners have node=null.",
		ExportFinding:
			"FindingSummary decisions plus node (catalog ApiNode), action/reason display text, routes, reports[], scopes[], compatibility, usageIds[], cleanupIds[]. Resolve IDs in occurrences; imports are consumers, re-exports are wiring.",
		SummaryEnvelope:
			"Common fields plus total, filters, counts {change,assessment,constraint,scope}. Constraint and scope counts count each finding once per code and can overlap.",
		ExportV2:
			"version=2, analysisId, repository, generatedAt, reports, coverage, reportLoadingIncomplete, filters, findingCount, findings (ExportFinding[]), occurrences[], diagnostics[]. Same version-2 export as the UI; API adds analysisId.",
		Error:
			"{schemaVersion:1,error:{code,message}}; 400 invalid-request, 404 not-found, 405 method-not-allowed, 409 stale-analysis, 500 reports-unavailable. GET only; no notes/source mutations. Unknown or duplicate parameters are rejected.",
	},
};
/** @internal Local read-only transport. Loader injection keeps tests independent of a checkout or browser. */
export function createFindingsApi(load: () => Snapshot) {
	let cached: { id: string; findings: ReturnType<typeof removalCandidates> } | undefined;
	return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (!url.pathname.startsWith(prefix)) {
			next();
			return;
		}
		response.setHeader("Content-Type", "application/json; charset=utf-8");
		response.setHeader("Cache-Control", "no-store");
		const send = (body: unknown) => response.end(JSON.stringify(body));
		try {
			if (request.method !== "GET") {
				response.setHeader("Allow", "GET");
				throw new RequestError(405, "method-not-allowed", "This API is read-only. Use GET.");
			}
			if (url.pathname === `${prefix}schema`) {
				parameters(url, []);
				send(schema);
				return;
			}
			const endpoint = url.pathname.slice(prefix.length);
			if (
				!["findings", "findings/detail", "findings/summary", "findings/export"].includes(endpoint)
			)
				throw new RequestError(404, "not-found", "Unknown API endpoint. See /api/v1/schema.");
			parameters(
				url,
				endpoint === "findings/detail"
					? ["id", "analysisId"]
					: [...filterKeys, "analysisId", ...(endpoint === "findings" ? ["limit", "cursor"] : [])],
			);
			const filters = filtersFor(url);
			const limitText = url.searchParams.get("limit") ?? "50";
			if (!/^[1-9]\d*$/.test(limitText) || Number(limitText) > 200)
				badRequest("limit must be an integer from 1 to 200.");
			const limit = Number(limitText);
			const snapshot = load();
			const analysisId = analysisIdentity(snapshot);
			if (url.searchParams.has("analysisId") && url.searchParams.get("analysisId") !== analysisId)
				throw new RequestError(
					409,
					"stale-analysis",
					"Evidence changed. Restart from the first page.",
				);
			if (cached?.id !== analysisId)
				cached = { id: analysisId, findings: removalCandidates(snapshot) };
			const common = {
				schemaVersion: 1,
				analysisId,
				coverage: {
					...snapshot.coverage,
					complete: !absenceBlocked(snapshot),
					scope: "loaded-sources",
				},
				repository: snapshot.repository,
				reports: snapshot.reports ?? [],
			};
			if (endpoint === "findings/detail") {
				const id = url.searchParams.get("id");
				if (!id) badRequest("id is required.");
				const finding = cached.findings.find((f) => f.id === id);
				if (!finding)
					throw new RequestError(404, "not-found", "Finding not found in this analysis.");
				const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
				send({
					...common,
					finding: findingRecord(finding),
					occurrences: [
						...new Map([...finding.usages, ...finding.cleanup].map((o) => [o.id, o])).values(),
					],
					retainingApis: finding.retainingApiIds.map((id) => ({ id, node: byId.get(id) ?? null })),
					wiring: finding.routes.map((r) => ({
						routeId: r.id,
						evidence: byId.get(r.id)?.evidence ?? [],
						keepReasons: byId.get(r.id)?.keepReasons ?? [],
					})),
				});
				return;
			}
			const findings = filterFindings(cached.findings, filters);
			if (endpoint === "findings/export") {
				response.setHeader(
					"Content-Disposition",
					'attachment; filename="api-removal-candidates.json"',
				);
				await pipeline(
					Readable.from(findingsExportParts(snapshot, findings, filters, analysisId)),
					response,
				);
				return;
			}
			if (endpoint === "findings/summary") {
				const count = (values: (finding: (typeof findings)[number]) => string[]) => {
					const counts = new Map<string, number>();
					for (const finding of findings)
						for (const value of new Set(values(finding)))
							counts.set(value, (counts.get(value) ?? 0) + 1);
					return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
				};
				send({
					...common,
					total: findings.length,
					filters,
					counts: {
						change: count((f) => [f.proposedChange]),
						assessment: count((f) => [f.assessment]),
						constraint: count((f) => f.constraints.map((c) => c.code)),
						scope: count((f) => f.observedUsage),
					},
				});
				return;
			}
			let offset = 0;
			const cursor = url.searchParams.get("cursor");
			const filterId = JSON.stringify(filters);
			if (cursor !== null) {
				let decoded;
				try {
					decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
				} catch {
					badRequest("Malformed cursor.");
				}
				if (
					!decoded ||
					typeof decoded.analysisId !== "string" ||
					typeof decoded.filterId !== "string" ||
					!Number.isSafeInteger(decoded.offset) ||
					decoded.offset < 0
				)
					badRequest("Malformed cursor.");
				if (decoded.analysisId !== analysisId || decoded.filterId !== filterId)
					throw new RequestError(
						409,
						"stale-analysis",
						"Cursor evidence or filters changed. Restart from the first page.",
					);
				offset = decoded.offset;
				if (offset > findings.length) badRequest("Cursor offset is outside the result set.");
			}
			const page = findings.slice(offset, offset + limit);
			const nextCursor =
				offset + limit < findings.length
					? Buffer.from(JSON.stringify({ analysisId, filterId, offset: offset + limit })).toString(
							"base64url",
						)
					: null;
			send({
				...common,
				total: findings.length,
				filters,
				nextCursor,
				findings: page.map((f) => ({
					id: f.id,
					name: f.node.label,
					package: f.node.package,
					declaringPackage: f.declaringPackage,
					source: f.node.source
						? { path: f.node.source.path, line: f.node.source.line, column: f.node.source.column }
						: null,
					proposedChange: f.proposedChange,
					assessment: f.assessment,
					declarationAssessment: f.declarationAssessment,
					observedUsage: f.observedUsage,
					retainingApiIds: f.retainingApiIds,
					constraints: f.constraints,
					routes: f.routes,
				})),
			});
		} catch (error) {
			if (response.headersSent || response.destroyed) {
				response.destroy();
				return;
			}
			response.removeHeader("Content-Disposition");
			response.statusCode = error instanceof RequestError ? error.status : 500;
			send({
				schemaVersion: 1,
				error: {
					code: error instanceof RequestError ? error.code : "reports-unavailable",
					message:
						error instanceof RequestError
							? error.message
							: "Unable to analyze reports. Check the configured directory and regenerate malformed reports.",
				},
			});
		}
	};
}
