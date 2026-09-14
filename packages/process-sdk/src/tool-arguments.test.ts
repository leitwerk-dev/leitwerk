import { expect, it } from "vitest";
import { projectParameters } from "./tool-arguments.js";

it.each([undefined, ["number"], []])("keeps explicit required fields: %j", (required) => {
	const properties = { number: { type: "integer" }, note: { type: "string" } };
	expect(projectParameters(properties, required)).toEqual({
		type: "object",
		properties: {
			projectKey: { type: "string", description: "Current process project key" },
			...properties,
		},
		required: ["projectKey", ...(required ?? ["number", "note"])],
	});
});
