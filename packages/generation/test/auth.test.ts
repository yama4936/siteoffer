import { describe, expect, it } from "vitest";
import { accessOnlyChatGptAuth } from "../src/sandbox/auth.ts";

describe("現在のChatGPT認証の共有", () => {
  it("アクセス認証を保持し、ホストの更新トークンとAPIキーは渡さない", () => {
    const source = {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: "dummy-api-credential",
      last_refresh: "2026-10-14T07:00:00Z",
      tokens: {
        access_token: "dummy-access",
        refresh_token: "dummy-refresh",
        id_token: "dummy-id",
        account_id: "dummy-account",
      },
    };
    const result = accessOnlyChatGptAuth(source);
    expect(result.tokens.access_token).toBe("dummy-access");
    expect(result.tokens.account_id).toBe("dummy-account");
    expect(result.last_refresh).toBe(source.last_refresh);
    expect(result.tokens.refresh_token).toBe("");
    expect(result.OPENAI_API_KEY).toBeNull();
    expect(source.tokens.refresh_token).toBe("dummy-refresh");
  });

  it("APIキー認証と不完全な認証を拒否する", () => {
    for (const source of [null, {}, { auth_mode: "apikey" }, { auth_mode: "chatgpt", tokens: {} }]) {
      expect(() => accessOnlyChatGptAuth(source)).toThrow("ChatGPTログイン");
    }
  });
});
