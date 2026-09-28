/**
 * Свежесть данных экранов: повторный фокус не идёт в сеть, если с последней
 * успешной загрузки прошло меньше TTL и с тех пор не было мутаций.
 */

export const FOCUS_TTL_MS = 60_000;

/** Метка успешной загрузки. version — глобальный счётчик мутаций. */
export interface FreshMark {
  at: number;
  version: number;
}

export const STALE_MARK: FreshMark = { at: 0, version: -1 };

let dataVersion = 0;

/** Данные на сервере изменились — экраны перечитают их при следующем фокусе. */
export function bumpDataVersion(): void {
  dataVersion += 1;
}

export function freshMark(): FreshMark {
  return { at: Date.now(), version: dataVersion };
}

export function isFresh(mark: FreshMark): boolean {
  return mark.at > 0 && mark.version === dataVersion && Date.now() - mark.at < FOCUS_TTL_MS;
}
