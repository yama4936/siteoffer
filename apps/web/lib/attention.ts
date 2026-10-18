import {
  type Actor,
  authorizeConsultationActor,
  type Clock,
  err,
  fixedClock,
  listConsultationCases,
  ok,
  systemClock,
} from "@siteoffer/core";
import { companies, type DbOrTx } from "@siteoffer/db";
import { and, eq, inArray } from "drizzle-orm";
import type { AttentionItem, AttentionSummary } from "./attention-model";
import { emptyWorkFilters } from "./ops/work-filters";
import { getOpsWorkPage } from "./ops/work-page";
import { ASSIGNMENT_VIEWS, prioritizeAssignments } from "./sales/priorities";
import { listMyAssignments } from "./sales/queries";

/** Current work, not a second event inbox: resolving the source removes its notice. */
export async function getWorkspaceAttention(db: DbOrTx, actor: Actor | null, clock: Clock = systemClock) {
  if (!actor || (actor.kind !== "ops" && actor.kind !== "sales")) return err("forbidden");
  const now = clock.now();
  if (actor.kind === "ops") {
    const page = await getOpsWorkPage(db, actor, emptyWorkFilters, fixedClock(now));
    if (!page.ok) return page;
    return ok<AttentionSummary>({
      role: "ops",
      total: page.value.total,
      checkedAt: now.toISOString(),
      groups: page.value.groups
        .filter((group) => group.count > 0)
        .map((group) => ({
          key: group.key,
          label: group.label,
          count: group.count,
          href: `/ops?group=${group.key}`,
        })),
      items: page.value.items.slice(0, 6).map((item) => ({
        key: `${item.group}:${item.id}`,
        title: item.title,
        reason: item.reason,
        action: item.action,
        href: item.href,
        group: item.group,
      })),
    });
  }
  return db.transaction(
    async (tx) => {
      const authorized = await authorizeConsultationActor(tx, actor);
      if (!authorized.ok) return authorized;
      const [assigned, consultations] = await Promise.all([
        listMyAssignments(tx, actor),
        listConsultationCases(tx, actor, { status: "all", unread: true }),
      ]);
      if (!assigned.ok) return assigned;
      if (!consultations.ok) return consultations;
      // Suppressed companies must never receive a prompt to resume sales contact.
      const companyIds = [...new Set(assigned.value.map((row) => row.companyId))];
      const allowed = companyIds.length
        ? await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(inArray(companies.id, companyIds), eq(companies.suppression, "none")))
        : [];
      const allowedIds = new Set(allowed.map((row) => row.id));
      const rows = prioritizeAssignments(
        assigned.value.filter((row) => allowedIds.has(row.companyId)),
        now,
      ).filter((row) => ["conditions", "overdue", "today", "unscheduled"].includes(row.next.group));
      const groups: AttentionSummary["groups"] = [];
      for (const key of ["conditions", "overdue", "today", "unscheduled"] as const) {
        const count = rows.filter((row) => row.next.group === key).length;
        if (count) groups.push({ key, label: ASSIGNMENT_VIEWS[key], count, href: `/sales/assignments?view=${key}` });
      }
      if (consultations.value.total)
        groups.unshift({
          key: "consultation",
          label: "相談の未読更新",
          count: consultations.value.total,
          href: "/sales/consultations?status=all&unread=1",
        });
      const candidates: (AttentionItem & { priority: number; since: number })[] = rows.map((row) => ({
        key: `assignment:${row.id}`,
        title: row.companyName,
        reason: row.next.reason,
        action: row.next.label,
        href: `/sales/assignments/${row.id}`,
        group: row.next.group,
        priority: row.next.priority,
        since: Number.isFinite(row.next.due) ? row.next.due : row.claimedAt.getTime(),
      }));
      for (const row of consultations.value.rows.slice(0, 6))
        candidates.push({
          key: `consultation:${row.activityId}`,
          title: row.companyName,
          reason: "運営からの未確認の更新があります。相談の履歴で内容を確認してください。",
          action: "相談の回答を見る",
          href: `/sales/consultations?focus=${row.activityId}`,
          group: "consultation",
          priority: -2,
          since: -row.updatedAt.getTime(),
        });
      candidates.sort((a, b) => a.priority - b.priority || a.since - b.since || a.key.localeCompare(b.key));
      return ok<AttentionSummary>({
        role: "sales",
        total: rows.length + consultations.value.total,
        checkedAt: now.toISOString(),
        groups,
        items: candidates.slice(0, 6).map(({ priority: _priority, since: _since, ...item }) => item),
      });
    },
    { isolationLevel: "repeatable read" },
  );
}
