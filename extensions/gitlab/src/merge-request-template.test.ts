import { expect, it, vi } from "vitest";
import { mergeRequestBody } from "./merge-request-template.js";

const projectId = 42;
const revision = "a".repeat(40);
const dir = ".gitlab/merge_request_templates";
const body = "Implements the requested change";

function fixture(files: string[]) {
	const row = (path: string, type: string, mode = "100644") => ({ path, type, mode, id: "blob" });
	const listRepositoryTree = vi.fn(async (_id: number, ref: string, path = "") => {
		expect(ref).toBe(revision);
		if (path === "") return files.length ? [row(".gitlab", "tree")] : [];
		if (path === ".gitlab") return [row(dir, "tree")];
		expect(path).toBe(dir);
		return [
			...files.map((file) => row(`${dir}/${file}`, "blob")),
			row(`${dir}/Symlink.md`, "blob", "120000"),
			row(`${dir}/nested`, "tree"),
		];
	});
	const getRepositoryFile = vi.fn(async (_id: number, ref: string, path: string) => {
		expect(ref).toBe(revision);
		return {
			file_path: path,
			content: Buffer.from("# Summary\n\n- [ ] Verified\n\n/assign @example").toString("base64"),
			encoding: "base64",
			last_commit_id: revision,
		};
	});
	const client = {
		getProject: vi.fn(async () => ({
			id: projectId,
			default_branch: "main",
			path_with_namespace: "example/project",
			web_url: "https://gitlab.test/example/project",
			http_url_to_repo: "https://gitlab.test/example/project.git",
		})),
		getBranch: vi.fn(async () => ({
			name: "main",
			can_push: true,
			protected: false,
			commit: { id: revision, parent_ids: [], message: "Repository templates" },
		})),
		listRepositoryTree,
		getRepositoryFile,
	};
	const ctx = { signal: new AbortController().signal, reportProgress: vi.fn() };
	return { client, ctx, render: () => mergeRequestBody(client, projectId, body, ctx) };
}

it.each([
	{ files: ["Default.md", "Bugfix.md"], chosen: "Default.md" },
	{ files: ["Bugfix.md"], chosen: "Bugfix.md" },
])("uses $chosen from the project's default branch", async ({ files, chosen }) => {
	const f = fixture(files);
	expect(await f.render()).toBe(`# Summary\n\n- [ ] Verified\n\n\\/assign @example\n\n${body}`);
	expect(f.client.getBranch).toHaveBeenCalledWith(projectId, "main", f.ctx.signal);
	expect(f.client.getRepositoryFile).toHaveBeenCalledWith(
		projectId,
		revision,
		`${dir}/${chosen}`,
		f.ctx.signal,
	);
});

it.each([
	{ files: [], ambiguous: false },
	{ files: ["Bugfix.md", "Feature.md"], ambiguous: true },
])("keeps the normal body with no selected template ($files)", async ({ files, ambiguous }) => {
	const f = fixture(files);
	expect(await f.render()).toBe(body);
	expect(f.client.getRepositoryFile).not.toHaveBeenCalled();
	expect(f.ctx.reportProgress).toHaveBeenCalledTimes(ambiguous ? 1 : 0);
});

it("does not mistake a failed repository read for a missing template", async () => {
	const f = fixture(["Default.md"]);
	f.client.getRepositoryFile.mockRejectedValueOnce(new Error("Template unavailable"));
	await expect(f.render()).rejects.toThrow("Template unavailable");
	expect(await f.render()).toContain("# Summary");
});
