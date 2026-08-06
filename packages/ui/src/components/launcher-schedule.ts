export interface LauncherScheduleDateTimeParts {
	date: string;
	time: string;
}

export interface LauncherScheduleTimeParts {
	hour: string;
	minute: string;
}

export interface LauncherScheduleOption {
	value: string;
	label: string;
}

function padScheduleNumber(value: number): string {
	return String(value).padStart(2, "0");
}

export function buildLauncherScheduleHourOptions(): LauncherScheduleOption[] {
	return Array.from({ length: 24 }, (_, index) => {
		const value = padScheduleNumber(index);
		return { value, label: value };
	});
}

export function buildLauncherScheduleMinuteOptions(stepMinutes = 1): LauncherScheduleOption[] {
	if (
		!Number.isInteger(stepMinutes) ||
		stepMinutes < 1 ||
		stepMinutes > 60 ||
		60 % stepMinutes !== 0
	) {
		throw new Error("stepMinutes must evenly divide 60");
	}
	return Array.from({ length: 60 / stepMinutes }, (_, index) => {
		const value = padScheduleNumber(index * stepMinutes);
		return { value, label: value };
	});
}

export function splitLauncherScheduleTimeString(value: string): LauncherScheduleTimeParts {
	const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
	if (!match) {
		return { hour: "", minute: "" };
	}
	return {
		hour: match[1],
		minute: match[2],
	};
}

export function buildLauncherScheduleTimeString(input: Partial<LauncherScheduleTimeParts>): string {
	const hour = typeof input.hour === "string" ? input.hour.trim() : "";
	const minute = typeof input.minute === "string" ? input.minute.trim() : "";
	return /^\d{2}$/.test(hour) && /^\d{2}$/.test(minute) ? `${hour}:${minute}` : "";
}

export function dateToLocalScheduleDateTimeParts(date: Date): LauncherScheduleDateTimeParts {
	const year = date.getFullYear();
	const month = padScheduleNumber(date.getMonth() + 1);
	const day = padScheduleNumber(date.getDate());
	const hours = padScheduleNumber(date.getHours());
	const minutes = padScheduleNumber(date.getMinutes());
	return {
		date: `${year}-${month}-${day}`,
		time: `${hours}:${minutes}`,
	};
}

export function currentLocalScheduleDateTimeParts(): LauncherScheduleDateTimeParts {
	return dateToLocalScheduleDateTimeParts(new Date());
}

export function isoToLocalScheduleDateTimeParts(iso: string): LauncherScheduleDateTimeParts {
	return dateToLocalScheduleDateTimeParts(new Date(iso));
}

export function localScheduleDateTimePartsToIso(
	input: Partial<LauncherScheduleDateTimeParts>,
): string | null {
	const dateValue = typeof input.date === "string" ? input.date.trim() : "";
	const timeValue = typeof input.time === "string" ? input.time.trim() : "";
	if (!dateValue || !timeValue) {
		return null;
	}
	const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
	const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue);
	if (!dateMatch || !timeMatch) {
		return null;
	}
	const [, yearValue, monthValue, dayValue] = dateMatch;
	const [, hourValue, minuteValue] = timeMatch;
	const year = Number(yearValue);
	const month = Number(monthValue);
	const day = Number(dayValue);
	const hour = Number(hourValue);
	const minute = Number(minuteValue);
	if (
		!Number.isInteger(year) ||
		!Number.isInteger(month) ||
		!Number.isInteger(day) ||
		!Number.isInteger(hour) ||
		!Number.isInteger(minute) ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > 31 ||
		hour < 0 ||
		hour > 23 ||
		minute < 0 ||
		minute > 59
	) {
		return null;
	}
	const localDate = new Date(year, month - 1, day, hour, minute, 0, 0);
	if (
		localDate.getFullYear() !== year ||
		localDate.getMonth() !== month - 1 ||
		localDate.getDate() !== day ||
		localDate.getHours() !== hour ||
		localDate.getMinutes() !== minute
	) {
		return null;
	}
	return localDate.toISOString();
}
