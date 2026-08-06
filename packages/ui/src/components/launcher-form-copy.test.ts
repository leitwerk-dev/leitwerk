import { describe, expect, it } from "vitest";
import {
	buildLauncherDefaultsNotice,
	getFirstLauncherFieldIdWithErrors,
	humanizeLauncherValidationMessage,
	normalizeLauncherValidationErrors,
} from "./launcher-form-copy.js";

const fields = [
	{
		id: "repoLocator",
		label: "Repository path or URL",
		kind: "text",
		required: true,
	},
	{
		id: "baseBranch",
		label: "Base branch",
		kind: "text",
	},
	{
		id: "workBranch",
		label: "Work branch",
		kind: "text",
		required: true,
	},
	{
		id: "prompt",
		label: "Requested change",
		kind: "textarea",
		required: true,
	},
] as const;

describe("launcher form copy helpers", () => {
	describe("humanizeLauncherValidationMessage", () => {
		it("shortens required field errors for inline display", () => {
			expect(
				humanizeLauncherValidationMessage(fields, {
					code: "required",
					fieldId: "workBranch",
					message: "workBranch is required",
				}),
			).toBe("Required.");
		});

		it("rewords repo locator errors in user-facing language", () => {
			expect(
				humanizeLauncherValidationMessage(fields, {
					code: "invalid_repo_locator",
					fieldId: "repoLocator",
					message: "repoLocator must be a local filesystem path or remote git URL",
				}),
			).toBe("Use a local path or remote Git URL.");
		});

		it("replaces field ids with visible field labels in other messages", () => {
			expect(
				humanizeLauncherValidationMessage(fields, {
					code: "custom_rule",
					fieldId: "baseBranch",
					message: "baseBranch must differ from workBranch",
				}),
			).toBe("Base branch must differ from Work branch");
		});
	});

	describe("normalizeLauncherValidationErrors", () => {
		it("splits field and form errors while preserving friendly copy", () => {
			const normalized = normalizeLauncherValidationErrors(fields, [
				{
					code: "required",
					fieldId: "prompt",
					message: "prompt is required",
				},
				{
					code: "custom_rule",
					message: "workBranch cannot match baseBranch",
				},
			]);

			expect(normalized.fieldErrors).toEqual({ prompt: ["Required."] });
			expect(normalized.formErrors).toEqual(["Work branch cannot match Base branch"]);
		});
	});

	describe("getFirstLauncherFieldIdWithErrors", () => {
		it("returns the first invalid field in schema order", () => {
			expect(
				getFirstLauncherFieldIdWithErrors(fields, {
					prompt: ["Required."],
					workBranch: ["Required."],
				}),
			).toBe("workBranch");
		});
	});

	describe("buildLauncherDefaultsNotice", () => {
		it("drops blank required-field warnings until the operator submits", () => {
			const notice = buildLauncherDefaultsNotice({
				fields,
				values: {
					repoLocator: "",
					baseBranch: "main",
					workBranch: "",
					prompt: "",
				},
				warnings: [
					{
						code: "invalid_repo_locator",
						fieldId: "repoLocator",
						message: "repoLocator must be a local filesystem path or remote git URL",
					},
					{
						code: "required",
						fieldId: "workBranch",
						message: "workBranch is required",
					},
					{
						code: "required",
						fieldId: "prompt",
						message: "prompt is required",
					},
				],
			});

			expect(notice).toBeNull();
		});

		it("keeps mixed warnings in an explicit review state", () => {
			const notice = buildLauncherDefaultsNotice({
				fields,
				values: {
					repoLocator: "/tmp/repo",
					baseBranch: "main",
					workBranch: "feature/example",
					prompt: "Ship it",
				},
				warnings: [
					{
						code: "custom_rule",
						fieldId: "baseBranch",
						message: "baseBranch must differ from workBranch",
					},
				],
			});

			expect(notice).toEqual({
				tone: "warning",
				title: "We adjusted some starter values",
				message: "Review the highlighted details before you launch.",
				fieldIds: ["baseBranch"],
				details: ["Base branch must differ from Work branch"],
			});
		});
	});
});
