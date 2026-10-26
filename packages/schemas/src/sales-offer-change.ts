import { z } from "zod";
export const offerChangeIdSchema = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
export const offerChangeProposalSchema = z
  .object({
    requestId: offerChangeIdSchema,
    assignmentId: offerChangeIdSchema,
    expectedOfferId: offerChangeIdSchema,
    productTermsId: offerChangeIdSchema,
    proposalVersionId: offerChangeIdSchema,
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export const offerChangeDecisionSchema = z
  .object({
    changeId: offerChangeIdSchema,
    decision: z.enum(["accept", "decline", "cancel"]),
    note: z.string().trim().max(2000).default(""),
    confirmed: z.boolean().default(false),
  })
  .strict();
export type OfferChangeProposal = z.input<typeof offerChangeProposalSchema>;
export type OfferChangeDecision = z.input<typeof offerChangeDecisionSchema>;
