import { type Component, mount, unmount } from "svelte";
import { afterEach } from "vitest";

const mounted = new Set<ReturnType<typeof mount>>();

/** @internal */
export async function unmountTests() {
	for (const app of [...mounted]) {
		mounted.delete(app);
		await unmount(app);
	}
	document.body.replaceChildren();
}

afterEach(unmountTests);

/** @internal */
export function mountTest<Props extends Record<string, unknown>>(
	component: Component<Props>,
	props: Props,
) {
	const target = document.createElement("div");
	document.body.append(target);
	const app = mount(component, { target, props });
	mounted.add(app);
	return {
		app,
		target,
		/** @internal */
		async dispose() {
			if (mounted.delete(app)) await unmount(app);
		},
	};
}
