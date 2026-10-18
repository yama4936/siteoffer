import { z } from "zod";

export const COMPANY_PROFILE_FIELDS = {
  phone: "電話",
  email: "メール",
  hours: "受付時間",
  services: "提供サービス",
  industry: "業種",
  address: "所在地",
} as const;
export type CompanyProfileField = keyof typeof COMPANY_PROFILE_FIELDS;
const text = z.string().trim().min(1).max(1000);
const phone = z
  .string()
  .trim()
  .transform((value) => value.normalize("NFKC"))
  .pipe(
    z
      .string()
      .max(40)
      .regex(/^\+?[0-9() -]+$/)
      .refine((value) => {
        const digits = value.replace(/\D/g, "");
        return digits.length >= 8 && digits.length <= 15;
      }, "電話番号を確認してください"),
  );
export const companyProfileValuesSchema = z.strictObject({
  phone: phone.nullable(),
  email: z.string().trim().pipe(z.email().max(254)).nullable(),
  hours: text.nullable(),
  services: text.nullable(),
  industry: text.nullable(),
  address: text.nullable(),
});
export type CompanyProfileValues = z.infer<typeof companyProfileValuesSchema>;
export const saveCompanyProfileSchema = z.strictObject({
  companyId: z.uuid(),
  expectedRevision: z.number().int().min(0).max(2147483646),
  values: companyProfileValuesSchema,
  source: z.string().trim().min(3).max(1000),
  confirmed: z.literal(true),
});
export const EMPTY_COMPANY_PROFILE: CompanyProfileValues = {
  phone: null,
  email: null,
  hours: null,
  services: null,
  industry: null,
  address: null,
};
