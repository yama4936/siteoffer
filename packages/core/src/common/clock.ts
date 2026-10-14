/** 現在時刻の取得元。テストでは固定・前進できるものに差し替える */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(start: Date | string): Clock & { advance(ms: number): void; set(d: Date | string): void } {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
    set(d) {
      current = new Date(d);
    },
  };
}

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
