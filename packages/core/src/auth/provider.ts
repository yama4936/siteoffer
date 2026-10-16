import type { Actor } from "../common/actor.ts";
import type { Result } from "../common/result.ts";

/** ログイン済みのユーザー。actor は権限判定（can）と操作履歴に渡す */
export interface AuthenticatedUser {
  actor: Extract<Actor, { kind: "sales" | "ops" | "customer_user" }>;
  userId: string;
  email: string;
  displayName: string;
  role: "sales" | "ops" | "customer";
}

export interface RegisterSalesInput {
  email: string;
  password: string;
  displayName: string;
  /** 画面で同意した利用条件の版のID。同意していなければ null */
  acceptedTermsVersionId: string | null;
}

export type RegisterError =
  | "invalid_email"
  | "weak_password"
  | "invalid_display_name"
  | "terms_unavailable"
  | "terms_not_accepted"
  | "terms_outdated"
  | "email_taken";

/** 存在しないメールとパスワード違いは区別しない（どちらも invalid_credentials） */
export type LoginError = "invalid_credentials" | "suspended";

export type AuthenticateError = "invalid_session" | "session_expired" | "suspended";

export interface SessionToken {
  /** Cookieに入れる値。DBにはハッシュだけを保存する */
  token: string;
  expiresAt: Date;
}

/**
 * 認証の差し替え口（24.2）。ローカルは LocalAuthProvider（DBのパスワード＋セッション）。
 * 将来Cognito等へ移す場合はこのインターフェースを実装し、users.id との対応付けを実装側で持つ。
 * 役割・利用停止・利用条件の同意はアプリのDB（users・terms_acceptances）を正とする。
 */
export interface AuthProvider {
  /** 営業ユーザーの自己登録（F-30）。最新の利用条件への同意が必須。運営は自己登録できない */
  registerSales(input: RegisterSalesInput): Promise<Result<{ userId: string }, RegisterError>>;
  login(input: {
    email: string;
    password: string;
  }): Promise<Result<SessionToken & { user: AuthenticatedUser }, LoginError>>;
  /** リクエストごとに呼ぶ。期限切れ・利用停止のユーザーは拒否する */
  authenticate(token: string): Promise<Result<AuthenticatedUser, AuthenticateError>>;
  logout(token: string): Promise<void>;
}
