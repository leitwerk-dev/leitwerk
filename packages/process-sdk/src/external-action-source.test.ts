import { expect, it } from "vitest";
import { defineExternalActionSource } from "./external-action-source.js";

it("retains source metadata and typed resolvers with independent empty configs", () => {
	const metadata = {
		kind: "example",
		label: "Example",
		describeEvent: () => ({ summary: "Ready" }),
	};
	const source = defineExternalActionSource<{ id: string }>(metadata);
	const resolve = ({ params, state }: { params: string; state: number }) => ({
		id: params + state,
	});
	const first = source<string, number>(resolve);
	const second = source(resolve);
	expect(first).toEqual({ ...metadata, config: {}, inputMode: "none", resolve });
	expect(second).toEqual(first);
	expect(second).not.toBe(first);
	expect(second.config).not.toBe(first.config);
});
