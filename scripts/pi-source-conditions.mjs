import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (!specifier.startsWith("@earendil-works/") || !context.conditions.includes("source")) {
			return nextResolve(specifier, context);
		}
		return nextResolve(specifier, {
			...context,
			conditions: context.conditions.filter((condition) => condition !== "source"),
		});
	},
});
