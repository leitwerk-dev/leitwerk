import { describe, expect, it } from "vitest";
import {
	extractLatestChangelogRelease,
	formatOverallReleaseNotes,
	replaceGeneratedReleaseNotes,
} from "./update-release-pr-notes.mjs";

const changelog = `# Changelog

## [0.1.5](https://example.test/compare/v0.1.4...v0.1.5) (2026-08-10)

### Bug Fixes

* send runtime settings to automatic workers ([#12](https://example.test/pull/12))

## [0.1.4](https://example.test/compare/v0.1.3...v0.1.4) (2026-08-10)

### Bug Fixes

* improve release validation
`;

describe("release PR overall notes", () => {
	const generatedBody = `:robot: I have created a release *beep* *boop*
---

<details><summary>@leitwerk-dev/server: 0.1.5</summary>
package notes
</details>

<details><summary>v: 0.1.5</summary>
root notes
</details>

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).`;

	it("extracts only the latest release from the root changelog", () => {
		expect(
			extractLatestChangelogRelease(changelog),
		).toBe(`## [0.1.5](https://example.test/compare/v0.1.4...v0.1.5) (2026-08-10)

### Bug Fixes

* send runtime settings to automatic workers ([#12](https://example.test/pull/12))`);
	});

	it("formats the changelog entry as an embeddable overall section", () => {
		expect(formatOverallReleaseNotes(changelog)).toContain(`## Overall release notes

### [0.1.5](https://example.test/compare/v0.1.4...v0.1.5) (2026-08-10)

#### Bug Fixes`);
	});

	it("adds overall notes without removing generated component sections", () => {
		const updated = replaceGeneratedReleaseNotes(generatedBody, changelog);
		expect(updated).toContain("send runtime settings to automatic workers");
		expect(updated).toContain("<details><summary>@leitwerk-dev/server: 0.1.5</summary>");
		expect(updated).toContain("package notes");
		expect(updated).toContain("<details><summary>v: 0.1.5</summary>");
		expect(updated).toContain("root notes");
		expect(updated).toContain("This PR was generated with [Release Please]");
	});

	it("replaces stale overall notes without duplicating the marked block", () => {
		const initial = replaceGeneratedReleaseNotes(generatedBody, changelog);
		const nextChangelog = changelog.replaceAll("0.1.5", "0.1.6");
		const updated = replaceGeneratedReleaseNotes(initial, nextChangelog);
		expect(updated.match(/leitwerk-overall-release-notes:start/gu)).toHaveLength(1);
		expect(updated).toContain("### [0.1.6]");
		expect(updated).not.toContain("### [0.1.5]");
		expect(updated).toContain("<details><summary>v: 0.1.5</summary>");
		expect(updated).toContain("root notes");
	});

	it("rejects invalid overall notes markers", () => {
		const body = generatedBody.replace(
			"<details>",
			"<!-- leitwerk-overall-release-notes:start -->\n<details>",
		);
		expect(() => replaceGeneratedReleaseNotes(body, changelog)).toThrow(
			"release PR body has invalid overall release notes markers",
		);
	});

	it("rejects an unexpected pull request body instead of deleting unknown content", () => {
		expect(() => replaceGeneratedReleaseNotes("custom pull request body", changelog)).toThrow(
			"release PR body does not match the expected Release Please format",
		);
	});

	it("rejects a changelog with no release entry", () => {
		expect(() => extractLatestChangelogRelease("# Changelog\n")).toThrow(
			"CHANGELOG.md has no release heading",
		);
	});
});
