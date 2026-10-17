"use client";
import type {
  getImageSubmission,
  getPublicationMaterial,
  listCustomerImages,
  listImageSubmissionsForOps,
  listPublicationMaterials,
} from "@siteoffer/core";
import { emptyWorkFilters, type WorkFilters, workHref } from "@/lib/ops/work-filters";
import type { WorkPage } from "@/lib/ops/work-page";
import { readPrivate } from "./private-read";

function query(values: Record<string, string | number | undefined>) {
  return new URLSearchParams(
    Object.entries(values)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}
export function readWorkQueue(signal?: AbortSignal, filters: WorkFilters = emptyWorkFilters) {
  return readPrivate<WorkPage>(workHref(filters, "/ops/work-queue"), signal);
}
export function readCustomerImages(companyId: string, page: number, signal?: AbortSignal) {
  return readPrivate<Awaited<ReturnType<typeof listCustomerImages>>>(
    `/customer/materials/updates?${query({ kind: "list", company: companyId, page })}`,
    signal,
  );
}
export function readOpsImages(input: Parameters<typeof listImageSubmissionsForOps>[2], signal?: AbortSignal) {
  return readPrivate<Awaited<ReturnType<typeof listImageSubmissionsForOps>>>(
    `/ops/materials/updates?${query({ kind: "list", company: input?.companyId, asset: input?.assetId, page: input?.page ?? 0, pending: input?.pendingOnly ? "1" : "0" })}`,
    signal,
  );
}
export function readImageSubmission(
  role: "ops" | "customer",
  companyId: string,
  assetId: string,
  signal?: AbortSignal,
) {
  return readPrivate<Awaited<ReturnType<typeof getImageSubmission>>>(
    `/${role}/materials/updates?${query({ kind: "item", company: companyId, asset: assetId })}`,
    signal,
  );
}
export function readMaterialCount(signal?: AbortSignal) {
  return readPrivate<number>("/ops/materials/updates?kind=count", signal);
}
export function readPublicationMaterials(input: Parameters<typeof listPublicationMaterials>[2], signal?: AbortSignal) {
  return readPrivate<Awaited<ReturnType<typeof listPublicationMaterials>>>(
    `/ops/publication-checks/updates?${query({ kind: "list", company: input?.companyId, delivery: input?.deliveryId, deployment: input?.deploymentId, page: input?.page ?? 0, mode: input?.mode ?? "pending" })}`,
    signal,
  );
}
export function readPublicationMaterial(deploymentId: string, signal?: AbortSignal) {
  return readPrivate<Awaited<ReturnType<typeof getPublicationMaterial>>>(
    `/ops/publication-checks/updates?${query({ kind: "item", deployment: deploymentId })}`,
    signal,
  );
}
