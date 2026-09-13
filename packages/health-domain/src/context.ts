import { z } from "zod";

import { InstantSchema } from "./observation.js";

export const MAX_AVAILABLE_MINUTES = 1_440;

function isIanaTimeZone(value: string): boolean {
  if (/^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function epoch(value: string): number { return Date.parse(value); }

function offsetMinutes(value: string): number {
  if (value.endsWith("Z")) return 0;
  const match = /([+-])(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return Number.NaN;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "+" ? minutes : -minutes;
}

function zoneOffsetAt(value: string, timeZone: string): number {
  const instant = new Date(epoch(value));
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const wall = new Date(0);
  wall.setUTCFullYear(get("year"), get("month") - 1, get("day"));
  wall.setUTCHours(get("hour"), get("minute"), get("second"), instant.getUTCMilliseconds());
  return (wall.getTime() - epoch(value)) / 60_000;
}

export const CurrentContextSchema = z
  .strictObject({
    localTime: InstantSchema,
    timeZone: z.string().min(1).refine(isIanaTimeZone),
    bedtime: InstantSchema.nullable(),
    availableMinutes: z.number().int().min(0).max(MAX_AVAILABLE_MINUTES).nullable()
  })
  .superRefine((context, issue) => {
    if (!isIanaTimeZone(context.timeZone) || !InstantSchema.safeParse(context.localTime).success ||
      (context.bedtime !== null && !InstantSchema.safeParse(context.bedtime).success)) return;
    if (offsetMinutes(context.localTime) !== zoneOffsetAt(context.localTime, context.timeZone)) {
      issue.addIssue({ code: "custom", path: ["localTime"], message: "local time offset must match time zone" });
    }
    if (context.bedtime !== null && offsetMinutes(context.bedtime) !== zoneOffsetAt(context.bedtime, context.timeZone)) {
      issue.addIssue({ code: "custom", path: ["bedtime"], message: "bedtime offset must match time zone" });
    }
    if (context.bedtime !== null) {
      const untilBedtime = epoch(context.bedtime) - epoch(context.localTime);
      if (untilBedtime < 0 || untilBedtime > 86_400_000) {
        issue.addIssue({ code: "custom", path: ["bedtime"], message: "bedtime must be within 24 hours" });
      }
    }
  });

export type CurrentContext = z.infer<typeof CurrentContextSchema>;
