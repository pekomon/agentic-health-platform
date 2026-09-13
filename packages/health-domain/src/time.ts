import { z } from "zod";

import { LocalDateSchema, type LocalDate } from "./observation.js";

export const MIN_HISTORY_DAYS = 1;
export const MAX_HISTORY_DAYS = 14;

export const HistoryWindowSchema = z
  .strictObject({ startDate: LocalDateSchema, endDate: LocalDateSchema })
  .superRefine((window, context) => {
    if (window.startDate > window.endDate) {
      context.addIssue({ code: "custom", path: ["endDate"], message: "history window must be ordered" });
    }

    const length = countCalendarDays(window.startDate, window.endDate);
    if (length < MIN_HISTORY_DAYS || length > MAX_HISTORY_DAYS) {
      context.addIssue({ code: "custom", path: ["endDate"], message: "history window must contain 1..14 dates" });
    }
  });

export type HistoryWindow = z.infer<typeof HistoryWindowSchema>;

function utcDate(date: LocalDate): number {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(0);
  result.setUTCFullYear(year!, month! - 1, day!);
  return result.getTime();
}

export function countCalendarDays(startDate: LocalDate, endDate: LocalDate): number {
  return (utcDate(endDate) - utcDate(startDate)) / 86_400_000 + 1;
}

export function addCalendarDays(date: LocalDate, days: number): LocalDate {
  LocalDateSchema.parse(date);
  if (!Number.isInteger(days)) throw new RangeError("calendar day offset must be an integer");
  const result = new Date(utcDate(date) + days * 86_400_000);
  return LocalDateSchema.parse(result.toISOString().slice(0, 10));
}

export function makeHistoryWindow(today: LocalDate, days: number): HistoryWindow {
  if (!Number.isInteger(days) || days < MIN_HISTORY_DAYS || days > MAX_HISTORY_DAYS) {
    throw new RangeError("history days must be an integer from 1 through 14");
  }

  return { startDate: addCalendarDays(today, 1 - days), endDate: today };
}
