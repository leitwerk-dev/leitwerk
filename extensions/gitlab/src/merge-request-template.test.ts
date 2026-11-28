import { expect, it, vi } from "vitest";
import { GitLabClient } from "./client.js";
import { mergeRequestBody } from "./merge-request-template.js";

const dir = ".gitlab/merge_request_templates";
const body = "Implements the requested change";

function fixture(files: string[]) {
	const revision = "a".repeat(40);
	const trees = {
		"": files.length ? [{ path: ".gitlab", type: "tree" }] : [],
		".gitlab": [{ path: dir, type: "tree" }],
		[dir]: [
			...files.map((file) => ({ path: `${dir}/${file}`, type: "blob", mode: "100644" })),
			{ path: `${dir}/Symlink.md`, type: "blob", mode: "120000" },
		],
	};
	const fetch: typeof globalThis.fetch = async (input) => {
		const { pathname, searchParams } = new URL(String(input));
		if (pathname.endsWith("/projects/1")) return Response.json({ default_branch: "main" });
		if (pathname.endsWith("/branches/main")) return Response.json({ commit: { id: revision } });
		if (pathname.endsWith("/repository/tree"))
			return Response.json(trees[searchParams.get("path") ?? ""]);
		const path = decodeURIComponent(pathname.split("/").at(-1) ?? "");
		const markdown = `# ${path.slice(dir.length + 1)}\n\n- [ ] Verified\n\n/assign @example`;
		return Response.json({
			file_path: path,
			encoding: "base64",
			content: Buffer.from(markdown).toString("base64"),
		});
	};
	const client = new GitLabClient({ baseUrl: "https://gitlab.test", token: "test" }, { fetch });
	const read = vi.spyOn(client, "getRepositoryFile");
	const ctx = { signal: new AbortController().signal, reportProgress: vi.fn() };
	return { read, ctx, revision, render: () => mergeRequestBody(client, 1, body, ctx) };
}

it.each([
	{ files: ["Default.md", "Bugfix.md"], chosen: "Default.md" },
	{ files: ["Bugfix.md"], chosen: "Bugfix.md" },
])("uses $chosen from the project's default branch", async ({ files, chosen }) => {
	const f = fixture(files);
	expect(await f.render()).toBe(`# ${chosen}\n\n- [ ] Verified\n\n\\/assign @example\n\n${body}`);
	expect(f.read.mock.calls[0]?.[1]).toBe(f.revision);
});

it.each([
	{ files: [], ambiguous: false },
	{ files: ["Bugfix.md", "Feature.md"], ambiguous: true },
])("keeps the normal body with no selected template ($files)", async ({ files, ambiguous }) => {
	const f = fixture(files);
	expect(await f.render()).toBe(body);
	expect(f.read).not.toHaveBeenCalled();
	expect(f.ctx.reportProgress).toHaveBeenCalledTimes(ambiguous ? 1 : 0);
});

it("does not mistake a failed repository read for a missing template", async () => {
	const f = fixture(["Default.md"]);
	f.read.mockRejectedValueOnce(new Error("Template unavailable"));
	await expect(f.render()).rejects.toThrow("Template unavailable");
	expect(await f.render()).toContain("# Default.md");
});
