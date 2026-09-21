import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { analysisIdentity, createFindingsApi } from "../scripts/findings-api";
import { removalCandidates } from "../src/candidates";
import { filterFindings, findingsExportParts } from "../src/findings-export";
import type { Snapshot } from "../src/model";
import { findingsFixture } from "./fixtures/findings";

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
});
async function serve(load: () => Snapshot) {
	const api = createFindingsApi(load);
	const server = createServer((request, response) => {
		void api(request, response, () => {
			response.statusCode = 404;
			response.end();
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No TCP address");
	return (path: string, method = "GET") =>
		fetch(`http://127.0.0.1:${address.port}${path}`, { method });
}
it("serves discoverable read-only contracts and explicit errors", async () => {
	const request = await serve(findingsFixture);
	const schema = await (await request("/api/v1/schema")).json();
	expect(schema.enums.assessment).toContain("migration-required");
	expect(schema.endpoints["GET /api/v1/findings/detail"]).toBeDefined();
	for (const path of [
		"?limit=0",
		"?limit=201",
		"?limit=1.5",
		"?limit=1&limit=2",
		"?assessment=wrong",
		"?change=wrong",
		"?constraint=wrong",
		"?scope=wrong",
		"?directory=/tmp",
		"?cursor=bad",
	]) {
		const response = await request(`/api/v1/findings${path}`);
		expect(response.status, path).toBe(400);
		expect((await response.json()).error.code).toBe("invalid-request");
	}
	expect((await request("/api/v1/findings/detail")).status).toBe(400);
	expect((await request("/api/v1/findings/detail?id=missing")).status).toBe(404);
	expect((await request("/api/v1/unknown")).status).toBe(404);
	const response = await request("/api/v1/findings", "POST");
	expect(response.status).toBe(405);
	expect(response.headers.get("allow")).toBe("GET");
	expect(response.headers.get("cache-control")).toBe("no-store");
});
it("paginates deterministically and rejects changed evidence or filters", async () => {
	const snapshot = findingsFixture();
	snapshot.nodes.push(
		{ ...snapshot.nodes[1], id: "second" },
		{ ...snapshot.nodes[1], id: "third" },
	);
	const request = await serve(() => snapshot);
	const first = await (await request("/api/v1/findings?limit=1")).json();
	expect(first.total).toBe(3);
	expect(first.findings[0].id).toBe("helper");
	const next = `/api/v1/findings?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`;
	const second = await (await request(next)).json();
	expect(second.findings[0].id).toBe("second");
	expect((await request(`${next}&query=helper`)).status).toBe(409);
	expect(
		(await request(`/api/v1/findings/detail?id=helper&analysisId=${first.analysisId}`)).status,
	).toBe(200);
	snapshot.nodes[1].release = "public";
	expect((await request(next)).status).toBe(409);
	expect(
		(await request(`/api/v1/findings/detail?id=helper&analysisId=${first.analysisId}`)).status,
	).toBe(409);
	expect((await request(`/api/v1/findings/export?analysisId=${first.analysisId}`)).status).toBe(
		409,
	);
});
it("matches UI filtering and exports; resolves retaining owners, imports, snippets, and wiring", async () => {
	const snapshot = findingsFixture();
	snapshot.nodes.push({ id: "owner", label: "Owner", kind: "interface", package: "pkg" });
	snapshot.relationships.push({ from: "owner", to: "helper", kind: "type" });
	snapshot.occurrences[0].kind = "import";
	snapshot.nodes[1].evidence = [
		{ kind: "binding", label: "helper", detail: "Binding", source: snapshot.nodes[1].source! },
	];
	const request = await serve(() => snapshot);
	const filters = {
		query: "HELPER",
		change: "reduce-package-exposure" as const,
		constraint: "exported-signature" as const,
		package: "pkg",
		scope: "file-local-production",
	};
	const params = new URLSearchParams(filters).toString();
	const expected = filterFindings(removalCandidates(snapshot), filters);
	const list = await (await request(`/api/v1/findings?${params}`)).json();
	expect(list.findings.map((f: { id: string }) => f.id)).toEqual(expected.map((f) => f.id));
	expect(list.findings[0].source).not.toHaveProperty("snippet");
	const detail = await (
		await request(`/api/v1/findings/detail?id=helper&analysisId=${list.analysisId}`)
	).json();
	expect(detail.retainingApis[0].node.label).toBe("Owner");
	expect(detail.occurrences).toEqual(snapshot.occurrences);
	expect(detail.finding.cleanupIds).toEqual(["call"]);
	expect(detail.wiring[0].evidence).toEqual(snapshot.nodes[1].evidence);
	const response = await request(`/api/v1/findings/export?${params}`);
	expect(response.headers.get("content-disposition")).toContain("attachment");
	const exported = await response.json();
	expect(exported).toEqual(
		JSON.parse(findingsExportParts(snapshot, expected, filters, list.analysisId).join("")),
	);
	const summary = await (await request(`/api/v1/findings/summary?${params}`)).json();
	expect(summary.total).toBe(list.total);
	expect(summary.counts.constraint["exported-signature"]).toBe(1); // two action scopes, one finding
});
it("preserves uncertainty and positive retention in summary/detail and handles loader failures", async () => {
	const snapshot = findingsFixture();
	snapshot.reportLoadingIncomplete = true;
	const request = await serve(() => snapshot);
	const list = await (await request("/api/v1/findings")).json();
	expect(list.coverage).toMatchObject({ complete: false, scope: "loaded-sources" });
	expect(list.findings[0].assessment).toBe("review-required");
	const summary = await (await request("/api/v1/findings/summary?query=missing")).json();
	expect(summary.total).toBe(0);
	const failed = await serve(() => {
		throw new Error("private path");
	});
	const response = await failed("/api/v1/findings");
	expect(response.status).toBe(500);
	expect(await response.text()).not.toContain("private path");
});
it("ignores volatile load timestamps but hashes evidence, diagnostics and coverage", () => {
	const s = findingsFixture(),
		id = analysisIdentity(s);
	s.generatedAt = "tomorrow";
	expect(analysisIdentity(s)).toBe(id);
	s.occurrences[0].snippet = "changed evidence";
	expect(analysisIdentity(s)).not.toBe(id);
});
