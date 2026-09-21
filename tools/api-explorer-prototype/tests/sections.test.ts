import { expect, it } from "vitest";
import { sectionForHash, sectionLinks } from "../src/sections";

it.each(Object.entries(sectionLinks))("resolves the bookmarkable %s section", (section, hash) => {
	expect(sectionForHash(hash)).toBe(section);
});

it.each(["", "#unknown", "#all-notes-extra"])("defaults %j to Explorer", (hash) => {
	expect(sectionForHash(hash)).toBe("graph");
});
