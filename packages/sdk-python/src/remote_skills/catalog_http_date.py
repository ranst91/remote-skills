"""Strict HTTP-date parsing shared by catalog caching and retry policy."""

from __future__ import annotations

import re


_IMF_FIXDATE = re.compile(
    r"(Mon|Tue|Wed|Thu|Fri|Sat|Sun), "
    r"([0-9]{2}) "
    r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) "
    r"([0-9]{4}) "
    r"([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT\Z"
)
_WEEKDAYS = ("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
_MONTHS = {
    "Jan": 1,
    "Feb": 2,
    "Mar": 3,
    "Apr": 4,
    "May": 5,
    "Jun": 6,
    "Jul": 7,
    "Aug": 8,
    "Sep": 9,
    "Oct": 10,
    "Nov": 11,
    "Dec": 12,
}
_MONTH_LENGTHS = (0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
_ECMASCRIPT_TRIM = frozenset(
    {
        "\u0009", "\u000A", "\u000B", "\u000C", "\u000D", "\u0020",
        "\u00A0", "\u1680",
        "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005",
        "\u2006", "\u2007", "\u2008", "\u2009", "\u200A", "\u2028",
        "\u2029", "\u202F", "\u205F", "\u3000", "\uFEFF",
    }
)


def trim_ecmascript_whitespace(value: str) -> str:
    """Match ECMAScript String.prototype.trim without Unicode-version drift."""

    start = 0
    end = len(value)
    while start < end and value[start] in _ECMASCRIPT_TRIM:
        start += 1
    while end > start and value[end - 1] in _ECMASCRIPT_TRIM:
        end -= 1
    return value[start:end]


def parse_imf_fixdate(value: str | None) -> float | None:
    """Return Unix seconds only for TypeScript-equivalent IMF-fixdate input.

    The accepted TypeScript contract deliberately rejects obsolete RFC850 and
    asctime HTTP-date forms instead of delegating to a permissive date parser.
    """

    if value is None:
        return None
    match = _IMF_FIXDATE.fullmatch(trim_ecmascript_whitespace(value))
    if match is None:
        return None

    weekday, day_text, month_text, year_text, hour_text, minute_text, second_text = (
        match.groups()
    )
    day = int(day_text)
    month = _MONTHS[month_text]
    year = int(year_text)
    hour = int(hour_text)
    minute = int(minute_text)
    second = int(second_text)
    month_length = _MONTH_LENGTHS[month]
    if month == 2 and _is_leap_year(year):
        month_length = 29
    if not 1 <= day <= month_length or hour > 23 or minute > 59 or second > 60:
        return None

    days = _days_from_civil(year, month, day)
    if _WEEKDAYS[(days + 4) % 7] != weekday:
        return None
    return float(days * 86_400 + hour * 3_600 + minute * 60 + second)


def _is_leap_year(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def _days_from_civil(year: int, month: int, day: int) -> int:
    adjusted_year = year - (1 if month <= 2 else 0)
    era = adjusted_year // 400
    year_of_era = adjusted_year - era * 400
    shifted_month = month + (-3 if month > 2 else 9)
    day_of_year = (153 * shifted_month + 2) // 5 + day - 1
    day_of_era = year_of_era * 365 + year_of_era // 4 - year_of_era // 100 + day_of_year
    return era * 146_097 + day_of_era - 719_468
