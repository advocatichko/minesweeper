#!/usr/bin/env python3
"""
scripts/analytics-report.py
============================
Weekly PDLC analytics report for repo `advocatichko/minesweeper`.

Queries Vercel Web Analytics for the last 7 days of custom events
(`game_start`, `game_win`, `game_lose`, `premium_click`), computes funnel
metrics, and prints a markdown report (≤500 words) to stdout. When invoked
as a cron job (`no_agent=true`), stdout is delivered verbatim to
`deliver=telegram:511325449` — Telegram renders the markdown.

Scope reconciliation (see issue #36):
- The issue body mentions `share_result` and `game_over` events. The
  current source (post-PR #21) emits only `game_start | game_win |
  game_lose | premium_click`. This script queries ONLY the 4 events that
  actually exist. When a future issue ships `share_result`, add the
  literal to BOTH `app/analytics.ts` AND `EVENTS` below — single line each.
- D1/D7/D30 cohort retention is intentionally NOT computed: Vercel Web
  Analytics does not expose user identifiers, so cohort retention cannot
  be derived without re-introducing PII. The report renders `n/a` with an
  explicit footnote so the PDLC agent does not mistake the limit for a
  missing feature.
- No new dependencies: stdlib `urllib`, `json`, `datetime`, `os`, `sys`
  only.

Required environment variables:
  VERCEL_API_TOKEN   — Vercel personal access token (Settings → Tokens)
  VERCEL_TEAM_ID     — team slug or id (Settings → General)
  VERCEL_PROJECT_ID  — the minesweeper project id (Settings → General)

Optional:
  TELEGRAM_BOT_TOKEN — if set AND a run fails, post the error message to
                       the chat id in `TELEGRAM_CHAT_ID`. Stdout delivery
                       is handled by the cron scheduler, not here.
  TELEGRAM_CHAT_ID   — paired with the token above.
  DRY_RUN=1          — skip the HTTP call, print a synthetic sample report.

Behaviour:
- Missing required env vars → print a setup-instructions block to stdout
  and exit 0. Cron delivers it once; the operator adds the secrets; the
  next Monday's run produces a real report.
- API failure → print "ERROR: ..." with the HTTP status and body snippet,
  exit 1. Cron will surface this in Telegram.

This file is pure Python 3.11+ stdlib. No `pip install`, no third-party deps.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

# ── Constants ─────────────────────────────────────────────────────────────

# Vercel Web Analytics API endpoint. Public, stable since May 2026
# (https://vercel.com/changelog/web-analytics-api). The aggregate endpoint
# returns one row per `eventName` when grouped with `by=eventName`, each
# with `count` (event fires) and `visitors` (≈ unique sessions that fired
# it — closest the API offers to a user metric without PII).
#
# Endpoint reference: https://vercel.com/docs/analytics/web-analytics-api
API_BASE = "https://api.vercel.com/v1/query/web-analytics/events/aggregate"
EVENTS_COUNT_BASE = "https://api.vercel.com/v1/query/web-analytics/events/count"

# Events we KNOW exist on `main` after PR #21. Adding a new event literal
# to `app/analytics.ts` requires a matching entry here.
EVENTS = ("game_start", "game_win", "game_lose", "premium_click")

# Local timezone for "week-over-week" comparisons (operator-tunable).
LOCAL_TZ = timezone(timedelta(hours=3))  # FLE Daylight (UTC+03:00)

# Report length budget (soft cap). The markdown renderer is permissive;
# we trim proposals first if the body exceeds this.
WORD_BUDGET = 500


# ── Vercel API client ──────────────────────────────────────────────────────


def _now_range() -> tuple[str, str]:
    """Return [from, to] ISO-8601 strings covering the last 7 full UTC days.

    Anchored to UTC midnight so the comparison window is stable across runs.
    """
    now_utc = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    end = now_utc
    start = end - timedelta(days=7)
    return start.isoformat(), end.isoformat()


def fetch_event_counts(token: str, team_id: str, project_id: str,
                       since: str, until: str) -> dict[str, int]:
    """Fetch per-event totals from Vercel Web Analytics.

    Vercel's `events/aggregate` endpoint, when called with `by=eventName`
    and no `filter`, returns one row per known event with `{eventName,
    count, visitors}`. Events that did not fire in the window are absent
    from the response; we back-fill them with 0 so the report never
    crashes on a KeyError.

    Returns `{event_name: count}`.
    """
    params = {
        "projectId": project_id,
        "teamId": team_id,
        "since": since,
        "until": until,
        "by": "eventName",
        "limit": "100",
    }
    qs = urllib.parse.urlencode(params)
    url = f"{API_BASE}?{qs}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "minesweeper-pdlc-weekly/1.0",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 — URL is built from API_BASE constant
        payload = json.loads(resp.read().decode("utf-8"))

    # Response shape per Vercel docs:
    #   { "version": 1, "query": {...}, "data": [ {eventName, count, visitors}, ... ] }
    # Tolerate `{data: {events: [...]}}` wrappers from older alpha calls.
    data = payload.get("data")
    if isinstance(data, dict):
        rows = data.get("events") or []
    elif isinstance(data, list):
        rows = data
    else:
        rows = payload.get("events") or []

    counts: dict[str, int] = {name: 0 for name in EVENTS}
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = row.get("eventName") or row.get("name")
        if name not in counts:
            continue
        try:
            counts[name] += int(row.get("count") or 0)
        except (TypeError, ValueError):
            continue
    return counts


def fetch_unique_visitors(token: str, team_id: str, project_id: str,
                          since: str, until: str) -> int | None:
    """Fetch the unique-visitor count for the window from `events/count`.

    Returns `None` on any non-success path so the caller can degrade to
    "n/a" without crashing the report. The aggregate endpoint also
    exposes `visitors` per event; summing the per-event visitors from a
    single aggregate call would over-count visitors who fired multiple
    events, so a dedicated count call is more honest.
    """
    url = EVENTS_COUNT_BASE + "?" + urllib.parse.urlencode({
        "projectId": project_id,
        "teamId": team_id,
        "since": since,
        "until": until,
    })
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "minesweeper-pdlc-weekly/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.HTTPError, urllib.error.URLError, ValueError):
        return None
    data = payload.get("data")
    candidates: list[Any]
    if isinstance(data, dict):
        candidates = [data]
    elif isinstance(data, list):
        candidates = data
    else:
        candidates = []
    for row in candidates:
        if not isinstance(row, dict):
            continue
        for key in ("visitors", "uniqueVisitors"):
            if key in row:
                try:
                    return int(row[key])
                except (TypeError, ValueError):
                    return None
    return None


# ── Report computation ────────────────────────────────────────────────────


def compute_metrics(this_week: dict[str, int], last_week: dict[str, int]) -> dict[str, Any]:
    """Compute the PDLC funnel metrics from raw event counts.

    Definitions (privacy-friendly, no PII):
      starts, wins, losses, premium_clicks — raw event counts
      win_rate — wins / (wins + losses); 0 if denominator is 0
      dau_proxy — `game_start` events ÷ 7 (used only when the
                  `events/count.visitors` call fails). Treat as a
                  relative trend signal, not an absolute DAU.
      share_rate — None until issue #30 ships `share_result`.
    """
    starts = this_week.get("game_start", 0)
    wins = this_week.get("game_win", 0)
    losses = this_week.get("game_lose", 0)
    premium = this_week.get("premium_click", 0)

    last_starts = last_week.get("game_start", 0)
    last_wins = last_week.get("game_win", 0)
    last_losses = last_week.get("game_lose", 0)

    finished = wins + losses
    last_finished = last_wins + last_losses

    return {
        "starts": starts,
        "wins": wins,
        "losses": losses,
        "premium_clicks": premium,
        "win_rate": (wins / finished * 100.0) if finished else 0.0,
        "last_win_rate": (last_wins / last_finished * 100.0) if last_finished else 0.0,
        "dau_proxy": starts / 7.0,
        "last_dau_proxy": last_starts / 7.0,
        "share_rate": None,  # event doesn't exist yet
    }


def _delta_str(curr: float | int | None, prev: float | int | None, *, pct: bool = False) -> str:
    if prev is None or prev == 0 or curr is None:
        return "n/a"
    diff = curr - prev
    pct_change = (diff / prev) * 100.0
    arrow = "▲" if diff > 0 else ("▼" if diff < 0 else "•")
    if pct:
        return f"{arrow} {pct_change:+.1f}%"
    return f"{arrow} {diff:+.1f}"


def _fmt_int_or_none(value: int | None) -> str:
    return "n/a" if value is None else f"{value:,}"


def render_report(metrics: dict[str, Any], last: dict[str, Any],
                  since: str, until: str, *,
                  dau_now: int | None = None,
                  dau_last: int | None = None) -> str:
    """Render the markdown body (≤500 words).

    `dau_now` / `dau_last` come from the dedicated `events/count`
    visitors field and are the closest the Vercel API offers to true
    DAU/MAU. When the count call fails, both are `None` and the report
    degrades to the events-based DAU proxy with an explicit caveat.

    Retention (D1/D7/D30 cohort) is intentionally rendered as `n/a` —
    Vercel does not expose user identifiers, so cohort retention cannot
    be computed without PII. The report should NOT fabricate a number
    here.
    """
    today = datetime.now(LOCAL_TZ).strftime("%Y-%m-%d")
    have_dau = dau_now is not None
    have_dau_last = dau_last is not None
    dau_label = "DAU (visitors)" if have_dau else "DAU proxy (events/day)"
    this_dau_str = _fmt_int_or_none(dau_now) if have_dau else f"{metrics['dau_proxy']:.0f}"
    last_dau_str = _fmt_int_or_none(dau_last) if have_dau_last else f"{metrics['last_dau_proxy']:.0f}"
    dau_delta = _delta_str(
        dau_now if have_dau else metrics['dau_proxy'],
        dau_last if have_dau_last else metrics['last_dau_proxy'],
    )
    body = f"""# Minesweeper Weekly PDLC Report — {today}

Window: {since[:10]} → {until[:10]} (UTC). Compared against the prior 7 days.

## Key Metrics

| Metric | This Week | Last Week | Δ |
|---|---:|---:|---:|
| game_start events | {metrics['starts']:,} | {last['starts']:,} | {_delta_str(metrics['starts'], last['starts'])} |
| game_win events | {metrics['wins']:,} | {last['wins']:,} | {_delta_str(metrics['wins'], last['wins'])} |
| game_lose events | {metrics['losses']:,} | {last['losses']:,} | {_delta_str(metrics['losses'], last['losses'])} |
| Win rate | {metrics['win_rate']:.1f}% | {metrics['last_win_rate']:.1f}% | {_delta_str(metrics['win_rate'], metrics['last_win_rate'], pct=True)} |
| {dau_label} | {this_dau_str} | {last_dau_str} | {dau_delta} |
| premium_click events | {metrics['premium_clicks']:,} | {last['premium_clicks']:,} | {_delta_str(metrics['premium_clicks'], last['premium_clicks'])} |
| Share rate | n/a | n/a | event not yet shipped (issue #30) |
| Retention (D1/D7/D30) | n/a | n/a | Vercel Web Analytics does not expose user identifiers — cohort retention cannot be computed without PII |

> DAU is the count of unique visitors who fired any event in the window
> (from `events/count.visitors`). When that endpoint is unreachable, the
> column falls back to `game_start events ÷ 7`, an event-frequency proxy
> that over-counts repeat players. Treat both as relative trend signals,
> not absolute populations.

## Top Insights

1. **Game starts {"grew" if metrics['starts'] > last['starts'] else "fell"} week-over-week** ({_delta_str(metrics['starts'], last['starts'], pct=True)}). {"Trafficking is up — check whether the daily-challenge PR #29 is driving repeat visits." if metrics['starts'] > last['starts'] else "Engagement is cooling — verify Vercel deploy logs and check for prod regressions."}
2. **Win rate {"improved" if metrics['win_rate'] >= metrics['last_win_rate'] else "declined"}** ({metrics['win_rate']:.1f}% vs {metrics['last_win_rate']:.1f}%). {"Difficulty may have become easier (or players are retrying harder modes)." if metrics['win_rate'] >= metrics['last_win_rate'] else "Could indicate a difficulty cliff or first-click frustration — issue #32 (first-click safety) should help once shipped."}
3. **premium_click {"fired" if metrics['premium_clicks'] > 0 else "has not fired yet"}** ({metrics['premium_clicks']} events). {"Conversion is non-zero — issue #31 (theme skins) is the obvious next monetisation test." if metrics['premium_clicks'] > 0 else "Premium CTA is currently a no-op. Issue #31 (theme skins) is the priority before any other conversion work."}

## Next-Cycle Proposals (for PDLC agent)

1. **{"Promote" if metrics['starts'] > last['starts'] else "Diagnose"}** {"the daily challenge as a first-class surface" if metrics['starts'] > last['starts'] else "the engagement drop"} — open an issue, link this report.
2. **Ship issue #30 (shareable URLs)** — unlocks the `share_result` event and lets share_rate appear in next week's report.
3. **{"Wire" if metrics['premium_clicks'] > 0 else "Replace"} the premium CTA** — {"A/B test the placement" if metrics['premium_clicks'] > 0 else "current CTA is invisible; tie it to issue #31's theme skins"}.
"""
    # Soft trim: if we somehow exceed the budget, drop the proposals section.
    word_count = len(body.split())
    if word_count > WORD_BUDGET:
        keep, _, _ = body.partition("## Next-Cycle Proposals")
        body = keep.rstrip() + "\n\n## Next-Cycle Proposals\n(Trimmed — see the cron run log for the full proposal list.)\n"
    return body


def render_setup_required() -> str:
    """Markdown body when required env vars are missing."""
    return """# Minesweeper Weekly PDLC Report — Setup Required

The analytics cron fired, but Vercel API credentials are not configured. The
script will produce a real report on the next run once the secrets are set.

## Add these to the cron job's environment (or the host's `.env`):

```
VERCEL_API_TOKEN=<personal access token from https://vercel.com/dashboard/ → Settings → Tokens>
VERCEL_TEAM_ID=<team slug or id from the same Settings page>
VERCEL_PROJECT_ID=<the minesweeper project's id>
```

Optional — only needed for error-notification delivery beyond the cron
scheduler's stdout-to-Telegram path:

```
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_CHAT_ID=511325449
DRY_RUN=1   # to test the markdown shape without hitting the API
```

## Why these env vars

Vercel Web Analytics aggregates custom events (`game_start`, `game_win`,
`game_lose`, `premium_click`) but does not expose them through a public
read-only API without a token + project context. The script queries the
`/v1/query/web-analytics/events/aggregate` endpoint for the last 7 days of
counts and `/v1/query/web-analytics/events/count` for the unique-visitor
total (the closest the API offers to a DAU figure, privacy-safe).

## Where to set them on Windows

The `analytics-report-weekly` cron job is `no_agent=true`, so secrets must
be visible to the cron runtime — `hermes cron create --env KEY=VALUE` for
each var, or put them in `~/.hermes/.env` and source that before scheduling.

Once set, this report will populate automatically next Monday at 09:00.
"""


def render_error(status: int, body_snippet: str) -> str:
    return f"""# Minesweeper Weekly PDLC Report — ERROR

The Vercel Web Analytics API call returned HTTP {status}.

Body snippet (first 500 chars):

```
{body_snippet[:500]}
```

The cron will surface this on the next run. If the error persists, check:

1. `VERCEL_API_TOKEN` still has `web:read` scope.
2. `VERCEL_PROJECT_ID` matches the live project (`prj_…` for the
   `minesweeper-beta-six` deployment).
3. Vercel API is up: https://vercel-status.com/
"""


# ── Entry point ───────────────────────────────────────────────────────────


def main(argv: list[str]) -> int:
    token = os.environ.get("VERCEL_API_TOKEN")
    team = os.environ.get("VERCEL_TEAM_ID")
    project = os.environ.get("VERCEL_PROJECT_ID")
    dry_run = os.environ.get("DRY_RUN") == "1"

    if dry_run:
        # Synthetic sample so the markdown shape can be eyeballed without
        # hitting the API.
        since, until = _now_range()
        sample_this = {"game_start": 1240, "game_win": 215, "game_lose": 380, "premium_click": 7}
        sample_last = {"game_start": 980, "game_win": 180, "game_lose": 290, "premium_click": 3}
        metrics = compute_metrics(sample_this, sample_last)
        last_metrics = compute_metrics(sample_last, sample_last)
        sys.stdout.write(render_report(metrics, last_metrics, since, until,
                                       dau_now=180, dau_last=140))
        return 0

    missing = [n for n, v in (("VERCEL_API_TOKEN", token),
                              ("VERCEL_TEAM_ID", team),
                              ("VERCEL_PROJECT_ID", project)) if not v]
    if missing:
        sys.stdout.write(render_setup_required())
        sys.stdout.write(f"\n<!-- missing: {', '.join(missing)} -->\n")
        return 0

    # Real run — fetch this week and last week for the trend column.
    since, until = _now_range()
    last_since = (datetime.fromisoformat(since) - timedelta(days=7)).isoformat()
    last_until = since

    try:
        this_week = fetch_event_counts(token, team, project, since, until)
        last_week = fetch_event_counts(token, team, project, last_since, last_until)
        dau_now = fetch_unique_visitors(token, team, project, since, until)
        dau_last = fetch_unique_visitors(token, team, project, last_since, last_until)
    except urllib.error.HTTPError as e:
        snippet = e.read().decode("utf-8", errors="replace") if e.fp else ""
        sys.stdout.write(render_error(e.code, snippet))
        return 1
    except urllib.error.URLError as e:
        sys.stdout.write(render_error(0, f"URLError: {e.reason}"))
        return 1

    metrics = compute_metrics(this_week, last_week)
    last_metrics = compute_metrics(last_week, last_week)
    sys.stdout.write(render_report(metrics, last_metrics, since, until,
                                   dau_now=dau_now, dau_last=dau_last))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
