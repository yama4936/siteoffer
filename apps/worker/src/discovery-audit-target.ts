import { createHash } from "node:crypto";
import type { AuditPayload } from "./queues.ts";

export const DISCOVERY_AUDIT_PREFIX = "discovery-site:";
type SiteTarget = { id: string; companyId: string; url: string };
/** One initial automatic diagnosis per company and exact selected website/URL. */
export function discoveryAuditPayload(site: SiteTarget): AuditPayload {
  const hash = createHash("sha256").update(new URL(site.url).href).digest("hex");
  return { companyId: site.companyId, requestKey: `${DISCOVERY_AUDIT_PREFIX}${site.id}:${hash}` };
}
export function matchesDiscoveryAuditTarget(payload: AuditPayload, site: SiteTarget | undefined) {
  if (!site || site.companyId !== payload.companyId) return false;
  try {
    return discoveryAuditPayload(site).requestKey === payload.requestKey;
  } catch {
    return false;
  }
}
