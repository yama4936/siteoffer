/**
 * AIの事前チェックの結果（proposal_versions.content.aiCheck）。
 * 形は運営画面と共通の packages/schemas/src/proposal-precheck.ts で定める。
 */
import type { ProposalPrecheck, ProposalPrecheckItem, ProposalPrecheckKey } from "@siteoffer/schemas";

export { PROPOSAL_PRECHECK_KEYS as PRECHECK_ITEM_KEYS } from "@siteoffer/schemas";
export type PrecheckItemKey = ProposalPrecheckKey;
export type PrecheckItem = ProposalPrecheckItem;
export type ProposalAiCheck = ProposalPrecheck;
