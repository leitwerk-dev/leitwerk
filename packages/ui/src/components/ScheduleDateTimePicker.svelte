<script lang="ts">
import {
	buildLauncherScheduleHourOptions,
	buildLauncherScheduleMinuteOptions,
} from "./launcher-schedule.js";

interface Props {
	dateId: string;
	hourId: string;
	minuteId: string;
	dateValue: string;
	hourValue: string;
	minuteValue: string;
	dataSection?: string;
	marker?: "action" | "launcher" | null;
	onDateChange: (value: string) => void;
	onHourChange: (value: string) => void;
	onMinuteChange: (value: string) => void;
}

let {
	dateId,
	hourId,
	minuteId,
	dateValue,
	hourValue,
	minuteValue,
	dataSection = "schedule-date-time-picker",
	marker = null,
	onDateChange,
	onHourChange,
	onMinuteChange,
}: Props = $props();

const scheduleHourOptions = buildLauncherScheduleHourOptions();
const scheduleMinuteOptions = buildLauncherScheduleMinuteOptions();
const markerAttrs = $derived(
	marker === "action"
		? { "data-action-form-field": true }
		: marker === "launcher"
			? { "data-launcher-form-field": true }
			: {},
);
</script>

<div class="schedule-date-time-picker" data-section={dataSection} data-time-format="24-hour">
	<input
		id={dateId}
		{...markerAttrs}
		type="date"
		value={dateValue}
		oninput={(event) => onDateChange((event.currentTarget as HTMLInputElement).value)}
	/>
	<div class="schedule-time-picker">
		<select
			id={hourId}
			value={hourValue}
			aria-label="Hour (24-hour)"
			onchange={(event) => onHourChange((event.currentTarget as HTMLSelectElement).value)}
		>
			<option value="">HH</option>
			{#each scheduleHourOptions as option (option.value)}
				<option value={option.value}>{option.label}</option>
			{/each}
		</select>
		<span class="schedule-time-separator" aria-hidden="true">:</span>
		<select
			id={minuteId}
			value={minuteValue}
			aria-label="Minute"
			onchange={(event) => onMinuteChange((event.currentTarget as HTMLSelectElement).value)}
		>
			<option value="">MM</option>
			{#each scheduleMinuteOptions as option (option.value)}
				<option value={option.value}>{option.label}</option>
			{/each}
		</select>
	</div>
</div>

<style>
	.schedule-date-time-picker {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 12px;
		align-items: center;
		padding: 12px 14px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 88%, white 12%);
		border-radius: 16px;
		background: color-mix(in srgb, white 88%, var(--chronicle-panel-muted) 12%);
	}

	.schedule-date-time-picker input,
	.schedule-date-time-picker select {
		margin: 0;
		min-height: 42px;
		padding: 0;
		border: 0;
		background: transparent;
		box-shadow: none;
	}

	.schedule-date-time-picker input:hover,
	.schedule-date-time-picker select:hover {
		border-color: transparent;
		background: transparent;
	}

	.schedule-time-picker {
		display: grid;
		grid-template-columns: minmax(72px, 88px) auto minmax(72px, 88px);
		gap: 8px;
		align-items: center;
	}

	.schedule-time-picker select {
		text-align: center;
	}

	.schedule-time-separator {
		font-size: 1rem;
		font-weight: 620;
		color: var(--chronicle-text-muted);
	}

	@media (max-width: 860px) {
		.schedule-date-time-picker,
		.schedule-time-picker {
			grid-template-columns: 1fr;
		}
	}

	:global(.schedule-choice) {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px;
		border-radius: 14px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 96%, white 4%);
		color: var(--chronicle-text);
		cursor: pointer;
	}

	:global(.schedule-choice[data-selected="true"]) {
		border-color: color-mix(in srgb, var(--chronicle-accent) 28%, var(--chronicle-border) 72%);
		background: color-mix(in srgb, white 94%, var(--chronicle-accent-soft) 6%);
	}

	:global(.schedule-choice input) {
		width: auto;
		height: auto;
		margin: 0;
	}
</style>
