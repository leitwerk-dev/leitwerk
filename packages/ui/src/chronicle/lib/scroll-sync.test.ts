import { describe, expect, it } from "vitest";
import { isNearChronicleBottom, scrollTopForAnchor, selectActiveAnchorId } from "./scroll-sync.js";

describe("chronicle scroll sync", () => {
	it("selects the active anchor from the bottom-biased chronicle viewport position", () => {
		const layouts = [
			{ anchorId: "a", top: 0, height: 240 },
			{ anchorId: "b", top: 320, height: 240 },
			{ anchorId: "c", top: 640, height: 240 },
		];

		expect(selectActiveAnchorId(layouts, { scrollTop: 0, clientHeight: 240 })).toBe("a");
		expect(selectActiveAnchorId(layouts, { scrollTop: 160, clientHeight: 240 })).toBe("b");
		expect(selectActiveAnchorId(layouts, { scrollTop: 600, clientHeight: 240 })).toBe("c");
	});

	it("computes a rail scroll target that keeps short sections fully visible without clipping tall ones", () => {
		expect(scrollTopForAnchor({ top: 640 }, 400)).toBeCloseTo(336);
		expect(scrollTopForAnchor({ top: 120 }, 400)).toBe(0);
		expect(scrollTopForAnchor({ top: 640, height: 240 }, 400)).toBe(480);
		expect(scrollTopForAnchor({ top: 640, height: 800 }, 400)).toBeCloseTo(336);
		expect(
			scrollTopForAnchor({ top: 640, height: 240 }, 400, {
				align: "start",
				startPaddingPx: 28,
			}),
		).toBe(612);
		expect(scrollTopForAnchor({ top: 1_240, height: 160 }, 400, { scrollHeight: 1_500 })).toBe(
			1_000,
		);
	});

	it("detects when the user is close enough to the bottom to auto-follow the live tail", () => {
		expect(isNearChronicleBottom({ scrollTop: 820, clientHeight: 180, scrollHeight: 1100 })).toBe(
			true,
		);
		expect(isNearChronicleBottom({ scrollTop: 680, clientHeight: 180, scrollHeight: 1100 })).toBe(
			false,
		);
		expect(isNearChronicleBottom({ scrollTop: 420, clientHeight: 240, scrollHeight: 0 })).toBe(
			false,
		);
	});
});
