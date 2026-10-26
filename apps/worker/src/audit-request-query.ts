import { sql } from "drizzle-orm";

/** audit_requestsをrとして参照する。履歴は残し、後続依頼がない停止だけを対応待ちとする。 */
export const auditRequestNeedsAttention = sql`(r.finished_at is not null and r.status in ('failed','blocked')
 and not exists(select 1 from audit_requests newer where newer.company_id=r.company_id
 and (newer.created_at,newer.id)>(r.created_at,r.id)))`;
