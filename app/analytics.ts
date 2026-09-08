// app/analytics.ts
//
// Single typed wrapper around the Vercel Web Analytics SDK. This module is the
// ONLY place in the codebase that is allowed to call the provider's `track`
// function. The UI must go through `track()` so we keep the surface small and
// can audit every emitted event.
//
// Privacy: no cookies, no user ids, no PII, no localStorage identity. Only
// anonymous, aggregate event counts.

import { track as vaTrack } from "@vercel/analytics/react";

// ── Allowed event names ──────────────────────────────────────────────────
//
// Keep this list in lock-step with the call sites in `app/Minesweeper.tsx`.
// Adding a new event requires adding both a literal here and a `Props` entry
// below; the compiler will then flag any caller that forgets to pass props.
export type AnalyticsEventName =
  | "game_start"
  | "game_win"
  | "game_lose"
  | "premium_click"
  | "daily_start"
  | "daily_share";

// ── Allowed prop shapes per event ───────────────────────────────────────
//
// `ts` is a client-side numeric timestamp (Date.now()). `time_seconds` is the
// already-running in-game timer and never alters game logic. `difficulty` is
// one of the literal `LevelName`s. No other fields are permitted.
type Difficulty = "easy" | "medium" | "hard";

export type AnalyticsEventProps = {
  game_start: { difficulty: Difficulty; ts: number };
  game_win: { difficulty: Difficulty; time_seconds: number; ts: number };
  game_lose: { difficulty: Difficulty; time_seconds: number; ts: number };
  premium_click: { ts: number };
  daily_start: { date: string; ts: number };
  daily_share: { date: string; method: "share" | "clipboard"; ts: number };
};

// ── Public helper ───────────────────────────────────────────────────────

export function track<N extends AnalyticsEventName>(
  name: N,
  props: AnalyticsEventProps[N],
): void {
  // The provider's own `track` accepts only primitive property values; our
  // prop shapes already satisfy that constraint, so we can pass through.
  vaTrack(name, props as Record<string, string | number | boolean | null | undefined>);
}