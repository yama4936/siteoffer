import { z } from "zod";

const uuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
export const deliveryPreparationInputSchema = z.strictObject({
  deliveryId: uuid,
  requestId: uuid,
  expectedRevision: z.number().int().min(0),
  proposalVersionId: uuid,
  scopeText: z.string().trim().max(6000),
  reason: z.string().trim().min(1).max(2000),
  confirmed: z.literal(true),
});
