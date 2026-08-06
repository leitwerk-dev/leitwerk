import { CronExpressionParser } from "cron-parser";

const CRON_FIELD_COUNT = 5;

function splitCronFields(expression: string): string[] {
	return expression
		.trim()
		.split(/\s+/)
		.filter((field) => field.length > 0);
}

export function nextCronOccurrenceUtc(expression: string, after = new Date()): string {
	const fields = splitCronFields(expression);
	if (fields.length !== CRON_FIELD_COUNT) {
		throw new Error("Cron expression must have exactly 5 fields: minute hour day month weekday");
	}
	const next = CronExpressionParser.parse(expression, {
		currentDate: after,
		tz: "UTC",
		strict: false,
	}).next();
	const nextIso = next.toISOString();
	if (!nextIso) {
		throw new Error("Couldn't compute the next cron occurrence");
	}
	return nextIso;
}
