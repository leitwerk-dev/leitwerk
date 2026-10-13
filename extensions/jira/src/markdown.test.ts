import { describe, expect, it } from "vitest";
import { jiraToMarkdown, markdownToJira } from "./markdown.js";

const fixtures = [
	{
		name: "headings and nested inline formatting",
		jira: "h2. *Requirements*\n\n*Bold _and italic_* and -old-",
		markdown: "## **Requirements**\n\n**Bold *and italic*** and ~~old~~",
	},
	{
		name: "mixed nested lists",
		jira: "# Parent\n#* *Child*\n#*# Grandchild\n# Second",
		markdown: "1. Parent\n   - **Child**\n      1. Grandchild\n1. Second",
	},
	{
		name: "links and protected inline code",
		jira: "[Docs|https://example.test/path_(one)] and {{**raw** [x|https://example.test]}}",
		markdown: "[Docs](<https://example.test/path_(one)>) and `**raw** [x|https://example.test]`",
	},
	{
		name: "tables containing links, code and escaped pipes",
		jira: "||Setting||Value||\n|[Docs|https://example.test]|{{a|b}} and x\\|y|",
		markdown:
			"| Setting | Value |\n| --- | --- |\n| [Docs](https://example.test) | `a\\|b` and x\\|y |",
		published: "||Setting||Value||\n|[Docs|https://example.test]|{{a|b}} and x\\|y|",
	},
	{
		name: "multiline quotes",
		jira: "{quote}\n*Important*\n\nA second paragraph.\n{quote}",
		markdown: "> **Important**\n> \n> A second paragraph.",
	},
	{
		name: "escaped formatting delimiters",
		jira: "\\*literal\\* and user\\_name",
		markdown: "\\*literal\\* and user\\_name",
	},
];

describe("Jira and Markdown conversion", () => {
	it.each(fixtures)("converts $name in both directions", ({ jira, markdown, published }) => {
		expect(jiraToMarkdown(jira)).toBe(markdown);
		expect(markdownToJira(markdown)).toBe(published ?? jira);
	});

	it("keeps code literal and chooses fences longer than embedded backticks", () => {
		const content = "*bold* _italic_ [x|https://example.test]\n```\n{panel}\n  trailing  ";
		expect(jiraToMarkdown(`{code:title=Log|language=text}\n${content}\n{code}`)).toBe(
			`\`\`\`\`text\n${content}\n\`\`\`\``,
		);
		expect(markdownToJira(`\`\`\`\`text\n${content}\n\`\`\`\``)).toBe(
			`{code:text}\n${content}\n{code}`,
		);
	});

	it("preserves noformat content and code spans containing macro names or backticks", () => {
		expect(jiraToMarkdown("{noformat}*raw*\n{{literal}}{noformat}")).toBe(
			"```\n*raw*\n{{literal}}\n```",
		);
		expect(jiraToMarkdown("{{{code} *raw* {code}}}")).toBe("`{code} *raw* {code}`");
		expect(jiraToMarkdown("{{`raw`}}")).toBe("`` `raw` ``");
		expect(markdownToJira("`` `raw` ``")).toBe("{{`raw`}}");
	});

	it("does not apply inline replacements inside Markdown code spans", () => {
		expect(markdownToJira("`**raw** [x](https://example.test) _name_`")).toBe(
			"{{**raw** [x](https://example.test) _name_}}",
		);
	});

	it("uses empty Markdown headers for Jira tables without a header row", () => {
		expect(jiraToMarkdown("|first|second|\n|third|fourth|")).toBe(
			"|  |  |\n| --- | --- |\n| first | second |\n| third | fourth |",
		);
	});

	it("retains unsupported or unclosed macros and normalizes line endings", () => {
		expect(jiraToMarkdown("{panel:title=Notes}Keep *this*{panel}\r\nh1. Next")).toBe(
			"{panel:title=Notes}Keep **this**{panel}\n# Next",
		);
		expect(jiraToMarkdown("{code:text}\nUnclosed macro")).toBe("{code:text}\nUnclosed macro");
		expect(markdownToJira("{panel}Literal HTML: <div>{panel}")).toBe(
			"\\{panel\\}Literal HTML: <div>\\{panel\\}",
		);
	});

	it("handles empty descriptions and explicit line breaks", () => {
		for (const input of [null, undefined, ""]) expect(jiraToMarkdown(input)).toBe("");
		expect(markdownToJira("")).toBe("");
		expect(jiraToMarkdown("First\\\\Second")).toBe("First  \nSecond");
		expect(markdownToJira("First  \nSecond")).toBe("First\\\\\nSecond");
	});
});
