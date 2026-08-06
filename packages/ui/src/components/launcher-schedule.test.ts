import { describe, expect, it } from "vitest";
import {
	buildLauncherScheduleHourOptions,
	buildLauncherScheduleMinuteOptions,
	buildLauncherScheduleTimeString,
	isoToLocalScheduleDateTimeParts,
	localScheduleDateTimePartsToIso,
	splitLauncherScheduleTimeString,
} from "./launcher-schedule.js";

describe("launcher schedule helpers", () => {
	it("round-trips local date and 24-hour time parts", () => {
		const originalIso = new Date(2026, 3, 24, 18, 45, 0, 0).toISOString();
		const parts = isoToLocalScheduleDateTimeParts(originalIso);

		expect(localScheduleDateTimePartsToIso(parts)).toBe(originalIso);
	});

	it("returns null when either the date or time is missing", () => {
		expect(localScheduleDateTimePartsToIso({ date: "2026-04-24", time: "" })).toBeNull();
		expect(localScheduleDateTimePartsToIso({ date: "", time: "18:45" })).toBeNull();
	});

	it("rejects invalid calendar dates and 24-hour times", () => {
		expect(localScheduleDateTimePartsToIso({ date: "2026-02-31", time: "18:45" })).toBeNull();
		expect(localScheduleDateTimePartsToIso({ date: "2026-04-24", time: "24:00" })).toBeNull();
		expect(localScheduleDateTimePartsToIso({ date: "2026-04-24", time: "18:60" })).toBeNull();
	});

	it("builds explicit 24-hour hour and minute options for the custom picker", () => {
		const hours = buildLauncherScheduleHourOptions();
		const minutes = buildLauncherScheduleMinuteOptions(15);

		expect(hours).toHaveLength(24);
		expect(hours[0]).toEqual({ value: "00", label: "00" });
		expect(hours[23]).toEqual({ value: "23", label: "23" });
		expect(minutes).toEqual([
			{ value: "00", label: "00" },
			{ value: "15", label: "15" },
			{ value: "30", label: "30" },
			{ value: "45", label: "45" },
		]);
	});

	it("splits and rebuilds schedule time strings for the custom time selectors", () => {
		expect(splitLauncherScheduleTimeString("18:45")).toEqual({ hour: "18", minute: "45" });
		expect(splitLauncherScheduleTimeString("bad")).toEqual({ hour: "", minute: "" });
		expect(buildLauncherScheduleTimeString({ hour: "18", minute: "45" })).toBe("18:45");
		expect(buildLauncherScheduleTimeString({ hour: "18", minute: "" })).toBe("");
	});

	it("rejects unsupported minute step sizes", () => {
		expect(() => buildLauncherScheduleMinuteOptions(7)).toThrowError(/stepMinutes/);
	});
});
