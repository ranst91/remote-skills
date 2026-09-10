const IMF_FIXDATE_PATTERN =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function parseImfFixdate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = IMF_FIXDATE_PATTERN.exec(value.trim());
  if (!match) return undefined;

  const weekday = match[1];
  const day = Number(match[2]);
  const month = MONTHS.indexOf(match[3] as (typeof MONTHS)[number]);
  const year = Number(match[4]);
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  const second = Number(match[7]);
  if (month < 0 || hour > 23 || minute > 59 || second > 60) return undefined;

  const date = new Date(0);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  date.setUTCFullYear(year, month, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    WEEKDAYS[date.getUTCDay()] !== weekday
  ) {
    return undefined;
  }
  return date.getTime() + (second === 60 ? 1_000 : 0);
}
