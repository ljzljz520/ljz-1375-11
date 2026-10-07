"""Time handling that never loses the timezone or the original expression.

All scheduling data is stored as *local wall-time strings* together with an
IANA timezone name. We convert to aware datetimes only for comparison / routing
math. Cross-midnight windows are supported via the `next_day` flag (end is on
the following local day). Window repetition is explicit:
  * full-date windows are ONE-OFF festival segments (no silent daily repeat);
  * time-only "HH:MM" windows repeat daily, anchored on the query day.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ISO_LOCAL = re.compile(r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$")
TIME_ONLY = re.compile(r"^(\d{2}):(\d{2})(?::(\d{2}))?$")


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def tz(name: str) -> ZoneInfo:
    return ZoneInfo(name)


def parse_local(s: str, zone: str) -> datetime:
    """Parse 'YYYY-MM-DDTHH:MM[:SS]' as wall time in `zone` (DST-correct)."""
    m = ISO_LOCAL.match(s or "")
    if not m:
        raise ValueError(f"bad local datetime: {s!r}")
    y, mo, d, h, mi, se = m.groups()
    return datetime(int(y), int(mo), int(d), int(h), int(mi), int(se or 0),
                    tzinfo=tz(zone))


def to_instant(s: str, zone: str) -> datetime:
    return parse_local(s, zone).astimezone(timezone.utc)


def fmt_local(dt: datetime, zone: str) -> str:
    return dt.astimezone(tz(zone)).strftime("%Y-%m-%dT%H:%M:%S")


@dataclass
class Window:
    start: datetime
    end: datetime
    zone: str
    raw_start: str
    raw_end: str
    repeating: bool = False          # daily service window?

    def contains(self, instant: datetime, day_offset: int = 0) -> bool:
        i = instant.astimezone(timezone.utc)
        st = self.start + timedelta(days=day_offset)
        en = self.end + timedelta(days=day_offset)
        return st.astimezone(timezone.utc) <= i < en.astimezone(timezone.utc)


def make_window(start_local: str, end_local: str, zone: str,
                next_day: bool = False) -> Window:
    sm, em = ISO_LOCAL.match(start_local), ISO_LOCAL.match(end_local)
    if sm and em:                      # dated one-off segment
        st = parse_local(start_local, zone)
        en = parse_local(end_local, zone)
        if next_day:
            # convention: the stored end time is on the following local day
            en += timedelta(days=1)
        elif en < st:
            raise ValueError(
                "window ends before it starts; set next_day=true or give the "
                "end its actual calendar date")
        return Window(st, en, zone, start_local, end_local, repeating=False)
    raise ValueError("time-only windows require an anchor date; "
                     "use make_daily_window")


def make_daily_window(anchor_local: str, start_hm: str, end_hm: str,
                      zone: str) -> Window:
    a = parse_local(anchor_local, zone)
    sh, sm, ss = _hm(start_hm)
    eh, em, es = _hm(end_hm)
    st = a.replace(hour=sh, minute=sm, second=ss)
    en = a.replace(hour=eh, minute=em, second=es)
    if en <= st:                      # crosses midnight
        en += timedelta(days=1)
    return Window(st, en, zone, start_hm, end_hm, repeating=True)


def _hm(x):
    mm = TIME_ONLY.match(x)
    if not mm:
        raise ValueError(f"bad HH:MM: {x!r}")
    h, mi, se = mm.groups()
    return int(h), int(mi), int(se or 0)


def parse_windows(windows_json: list[dict], zone: str,
                  anchor_local: str | None = None) -> list[Window]:
    """Dated windows => one-off. {"start":"08:00","end":"22:00"} => daily
    repeating anchored on `anchor_local` (or the query date handled upstream)."""
    out = []
    for w in windows_json or []:
        z = w.get("tz") or zone
        sl, el = w["start_local"], w["end_local"]
        if ISO_LOCAL.match(sl) and ISO_LOCAL.match(el):
            out.append(make_window(sl, el, z, bool(w.get("next_day"))))
        else:
            anchor = anchor_local
            if anchor is None:
                # anchor on "today" in that zone; fine for demo schedules
                anchor = datetime.now(tz(z)).strftime("%Y-%m-%dT00:00:00")
            out.append(make_daily_window(anchor, sl, el, z))
    return out


def earliest_open(windows: list[Window], earliest: datetime,
                  travel: timedelta, max_days: int = 7) -> datetime | None:
    """Earliest instant at which traversal can COMPLETE within one window.
    One-off windows are tried only at their own date; repeating windows across
    following days. Returns arrival instant or None."""
    best = None
    e = earliest.astimezone(timezone.utc)
    for win in windows:
        offsets = range(0, max_days + 1) if win.repeating else (0,)
        for k in offsets:
            ws = win.start + timedelta(days=k)
            we = win.end + timedelta(days=k)
            if we.astimezone(timezone.utc) <= e:
                continue                    # window already past
            dep_k = max(e, ws.astimezone(timezone.utc))
            arr = dep_k + travel
            if arr <= we.astimezone(timezone.utc):
                if best is None or arr < best:
                    best = arr
                break
    return best


def overlaps(a_start: datetime, a_end: datetime,
             b_start: datetime, b_end: datetime) -> bool:
    return (a_start.astimezone(timezone.utc) < b_end.astimezone(timezone.utc)
            and b_start.astimezone(timezone.utc) < a_end.astimezone(timezone.utc))


def add_seconds_local(start_local: str, seconds: int, zone: str) -> str:
    dt = parse_local(start_local, zone) + timedelta(seconds=seconds)
    return fmt_local(dt, zone)
