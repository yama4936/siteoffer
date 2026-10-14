export const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 200;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** 問題があれば理由を返す。問題なければ null */
export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `パスワードは${PASSWORD_MIN_LENGTH}文字以上にしてください`;
  if (password.length > PASSWORD_MAX_LENGTH) return `パスワードは${PASSWORD_MAX_LENGTH}文字以下にしてください`;
  return null;
}

export function validateDisplayName(name: string): boolean {
  return name.length >= 1 && name.length <= 100;
}

/** PostgreSQLの一意制約違反（23505）。drizzle が包んだ例外の cause も見る */
export function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 3 && cur && typeof cur === "object"; i++) {
    if ((cur as { code?: unknown }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
