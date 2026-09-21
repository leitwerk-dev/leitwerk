import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";
export default ts.config(
	{ ignores: ["node_modules/**", "dist/**", ".generated/**", "public/**"] },
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs["flat/recommended"],
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: { "@typescript-eslint/no-explicit-any": "off" },
	},
	{
		files: ["**/*.svelte"],
		languageOptions: { parserOptions: { parser: ts.parser } },
		rules: { "svelte/no-at-html-tags": "error" },
	},
);
