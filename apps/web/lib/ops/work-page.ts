import { type Actor, type Clock, err, fixedClock, ok, systemClock } from "@siteoffer/core";
import type { DbOrTx } from "@siteoffer/db";
import {
  emptyWorkFilters,
  parseWorkFilters,
  type WorkCursor,
  type WorkFilters,
  workFilterKey,
  workHref,
} from "./work-filters";
import type { WorkItem } from "./work-model";
import { getOpsWorkQueue } from "./work-queue";

const PAGE_SIZE = 20;
/** Merge bounded candidates from each work source in one snapshot. No file bodies are loaded. */
export async function getOpsWorkPage(
  db: DbOrTx,
  actor: Actor | null,
  input: WorkFilters = emptyWorkFilters,
  clock: Clock = systemClock,
) {
  const filters = parseWorkFilters(new URL(workHref(input), "http://local").searchParams);
  if (!filters) return err("invalid_input");
  return db.transaction(
    async (tx) => {
      const readingClock = fixedClock(clock.now());
      const first = await getOpsWorkQueue(tx, actor, readingClock, { query: filters.query });
      if (!first.ok) return first;
      const groups = first.value.groups;
      const included = groups.filter((g) => filters.group === "all" || filters.group === g.key);
      const offsets = filters.cursor?.offsets ?? {};
      const later = included
        .filter((g) => (offsets[g.key] ?? 0) > 0 && (offsets[g.key] ?? 0) < g.count)
        .map((g) => g.key);
      let candidates: WorkItem[] = first.value.items.filter(
        (item) => included.some((g) => g.key === item.group) && !(offsets[item.group] ?? 0),
      );
      if (later.length) {
        const following = await getOpsWorkQueue(tx, actor, readingClock, {
          query: filters.query,
          offsets,
          only: later,
          ...(filters.cursor?.publicationAfter ? { publicationAfter: filters.cursor.publicationAfter } : {}),
        });
        if (!following.ok) return following;
        candidates = candidates.concat(following.value.items);
      }
      candidates.sort(
        (a, b) =>
          a.priority - b.priority ||
          a.since.localeCompare(b.since) ||
          a.id.localeCompare(b.id) ||
          a.group.localeCompare(b.group),
      );
      const items = candidates.slice(0, PAGE_SIZE),
        next: WorkCursor = {
          filter: workFilterKey(filters.group, filters.query),
          offsets: { ...offsets },
          ...(filters.cursor?.publicationAfter ? { publicationAfter: filters.cursor.publicationAfter } : {}),
        };
      for (const item of items) {
        next.offsets[item.group] = (next.offsets[item.group] ?? 0) + 1;
        if (item.group === "publication_materials") next.publicationAfter = { since: item.since, id: item.id };
      }
      const matchedTotal = included.reduce((n, g) => n + g.count, 0);
      const skipped = included.reduce((n, g) => n + Math.min(offsets[g.key] ?? 0, g.count), 0);
      const hasMore = items.length > 0 && included.some((g) => g.count > (next.offsets[g.key] ?? 0));
      return ok({
        items,
        groups,
        total: first.value.total,
        matchedTotal,
        skipped,
        pageSize: PAGE_SIZE,
        filters,
        nextCursor: hasMore ? next : null,
      });
    },
    { isolationLevel: "repeatable read" },
  );
}
export type WorkPage = Extract<Awaited<ReturnType<typeof getOpsWorkPage>>, { ok: true }>["value"];
