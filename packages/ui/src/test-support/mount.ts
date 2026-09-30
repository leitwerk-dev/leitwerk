import { type Component, mount, unmount } from "svelte";
import { afterEach } from "vitest";

const mounted: ReturnType<typeof mount>[] = [];

afterEach(async () => {
	for (const app of mounted.splice(0)) await unmount(app);
	document.body.replaceChildren();
});

/** @internal */
export function mountTest<Props extends Record<string, unknown>>(
	component: Component<Props>,
	props: Props,
) {
	const target = document.createElement("div");
	document.body.append(target);
	const app = mount(component, { target, props });
	mounted.push(app);
	return { app, target };
}
