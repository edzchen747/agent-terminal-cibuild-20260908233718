/**
 * Find in terminal: the state behind the find bar both clients render.
 *
 * Searching is entirely local to a client. Each one runs xterm's SearchAddon
 * over its OWN buffer and nothing about a find crosses the host connection -
 * two people looking at the same session search independently, and neither
 * one's highlights or cursor position disturb the other's view.
 *
 * The addon owns the matching; this module owns only what the bar shows and
 * what a keypress means, so the two clients cannot drift apart on either. The
 * addon is the source of truth for the counts: a query change here clears the
 * tally rather than guessing at it, and the real numbers arrive through
 * applyFindResults when onDidChangeResults fires.
 */

/** What the find bar is showing right now. */
export interface FindState {
  open: boolean;
  query: string;
  /** Zero-based index of the active match, or -1 when there is no active one. */
  index: number;
  count: number;
}

export const CLOSED_FIND: FindState = { open: false, query: "", index: -1, count: 0 };

/**
 * Opens the bar, optionally seeding the query from the current selection -
 * the familiar editor behaviour of "find what I just highlighted".
 *
 * A seed only ever replaces the query when it is a single line of real text:
 * a multi-line terminal selection is almost never a search term, and letting
 * one in would silently wipe a query the user typed a moment ago. An empty or
 * absent seed keeps the previous query, so reopening the bar offers the last
 * thing searched for.
 */
export function openFind(state: FindState, seed?: string): FindState {
  const trimmed = (seed ?? "").trim();
  const usable = trimmed.length > 0 && !trimmed.includes("\n");
  if (!usable) return { ...state, open: true };
  if (trimmed === state.query) return { ...state, open: true };
  return { open: true, query: trimmed, index: -1, count: 0 };
}

/** Closes the bar, keeping the query so reopening offers it again. */
export function closeFind(state: FindState): FindState {
  return { ...state, open: false, index: -1, count: 0 };
}

/**
 * A new query. The tally is cleared rather than carried: the old counts
 * describe the old term, and showing them against the new one - even for the
 * frame before the addon reports - reads as a wrong answer rather than a
 * pending one.
 */
export function setFindQuery(state: FindState, query: string): FindState {
  if (query === state.query) return state;
  return { ...state, query, index: -1, count: 0 };
}

/**
 * The addon's own tally, from onDidChangeResults.
 *
 * resultIndex is -1 when the addon found matches but stopped tracking which
 * one is active (its match threshold was exceeded on a very large buffer).
 * That is not an error: the count still stands, so it is kept and only the
 * position is dropped - findStatusLabel then shows the bare count.
 */
export function applyFindResults(state: FindState, event: { resultIndex: number; resultCount: number }): FindState {
  const count = Math.max(0, event.resultCount);
  const index = count > 0 && event.resultIndex >= 0 && event.resultIndex < count ? event.resultIndex : -1;
  return { ...state, index, count };
}

/** What a keypress in the find input means. */
export type FindCommand = "next" | "previous" | "close" | "none";

/**
 * Enter steps forward, Shift+Enter back, Escape closes. Everything else is
 * ordinary typing and belongs to the input.
 */
export function findCommandForKey(event: { key: string; shiftKey: boolean }): FindCommand {
  if (event.key === "Escape") return "close";
  if (event.key === "Enter") return event.shiftKey ? "previous" : "next";
  return "none";
}

/**
 * The bar's status text: "3/17" when the active match is known, a bare "17"
 * when only the count is, "No results" for a query that matched nothing, and
 * nothing at all while the query is empty (there is no result to report yet,
 * and "No results" would read as a failure).
 */
export function findStatusLabel(state: FindState): string {
  if (state.query.length === 0) return "";
  if (state.count === 0) return "No results";
  if (state.index < 0) return `${state.count}`;
  return `${state.index + 1}/${state.count}`;
}
