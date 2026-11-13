import { Type } from "typebox";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";

const Now = Type.Object({
  timezone: Type.Optional(Type.String()),
});

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_OFFSET_MINUTES = 8 * 60;
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

/** Minutes east of UTC for `timeZone` at `at`, or null when the zone is unknown. */
function zoneOffsetMinutes(at: Date, timeZone: string): number | null {
  try {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
    })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value;
    if (name === undefined) return null;
    const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name);
    if (match === null) return null;
    if (match[1] === undefined) return 0;
    const sign = match[1] === "-" ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
  } catch {
    // An unknown zone throws a RangeError; an ICU-less runtime may throw too.
    return null;
  }
}

/** Local wall clock and weekday for a fixed offset, without needing ICU. */
function stamp(at: Date, offsetMinutes: number): string {
  const shifted = new Date(at.getTime() + offsetMinutes * 60_000);
  const iso = shifted.toISOString();
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  const label = `${hours}${minutes === 0 ? "" : `:${String(minutes).padStart(2, "0")}`}`;
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC${offsetMinutes >= 0 ? "+" : "-"}${label}（星期${weekday}）`;
}

/**
 * Report the current time. A tool rather than a line in the system prompt: a
 * per-turn timestamp inside a rendered section adds a system entry on every
 * request and breaks the provider's prompt cache prefix.
 */
export function nowTool(
  clock: () => Date = () => new Date(),
): ToolRegistration<typeof Now> {
  return {
    name: "now",
    description:
      "Current date and time. Returns UTC and China time (UTC+8) by default; " +
      "pass `timezone` for another IANA zone.",
    parameters: Now,
    replay: "safe",
    async execute({ timezone }): Promise<ToolExecutionResult> {
      const at = clock();
      const requested = timezone ?? DEFAULT_TIMEZONE;
      const resolvedOffset = zoneOffsetMinutes(at, requested);
      const offset = resolvedOffset ?? DEFAULT_OFFSET_MINUTES;
      const note = resolvedOffset === null
        ? `（时区 ${requested} 无法解析，已用 ${DEFAULT_TIMEZONE} / UTC+8）`
        : "";
      return {
        output: [
          { type: "text", text: `${stamp(at, offset)}${note} · ${at.toISOString()}` },
        ],
      };
    },
  };
}
