/**
 * Screen data freshness: a repeated focus does not hit the network if less than
 * TTL has passed since the last successful load and there have been no mutations since.
 */

export const FOCUS_TTL_MS = 60_000;

/** Marker of a successful load. version is the global mutation counter. */
export interface FreshMark {
  at: number;
  version: number;
}

export const STALE_MARK: FreshMark = { at: 0, version: -1 };

let dataVersion = 0;

/** Data on the server has changed — screens will re-fetch it on the next focus. */
export function bumpDataVersion(): void {
  dataVersion += 1;
}

export function freshMark(): FreshMark {
  return { at: Date.now(), version: dataVersion };
}

export function isFresh(mark: FreshMark): boolean {
  return mark.at > 0 && mark.version === dataVersion && Date.now() - mark.at < FOCUS_TTL_MS;
}
