import { describe, expect, it } from "vitest";
import { resolveUiDevServerOptions } from "./vite-server-config.js";

describe("resolveUiDevServerOptions", () => {
	it("uses the default Vite port when LEITWERK_UI_PORT is unset", () => {
		expect(resolveUiDevServerOptions({})).toEqual({
			port: 5173,
			strictPort: false,
		});
	});

	it("uses a requested port and enables strictPort when LEITWERK_UI_PORT is set", () => {
		expect(resolveUiDevServerOptions({ LEITWERK_UI_PORT: "50123" })).toEqual({
			port: 50123,
			strictPort: true,
		});
	});

	it("rejects invalid LEITWERK_UI_PORT values", () => {
		expect(() => resolveUiDevServerOptions({ LEITWERK_UI_PORT: "not-a-port" })).toThrow(
			/invalid leitwerk_ui_port/i,
		);
	});
});
