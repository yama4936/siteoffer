import { z } from "zod";
export const deliveryChangeInputSchema = z.strictObject({
  deliveryId: z.string().uuid().toLowerCase(),
  fromVersionId: z.string().uuid().toLowerCase(),
  requestId: z.string().uuid().toLowerCase(),
  expectedStatus: z.enum(["ready", "published", "delivered"]),
  reason: z.string().trim().min(1).max(1000),
  requestedChanges: z.string().trim().min(1).max(4000),
  confirmed: z.literal(true),
});
