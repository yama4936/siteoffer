import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Actor, fixedClock, HOUR, hashShareToken, issueShareLink, revokeShareLink } from "@siteoffer/core";
import {
  seedAssignment,
  seedCompany,
  seedDeliveryVersion,
  seedProposalVersion,
  seedUser,
} from "@siteoffer/core/share-link/testing";
import { assignments, type Db, shareLinks } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type StartedPreviewServer, startPreviewServer } from "../src/server.ts";

let db: Db;
let closeDb: () => Promise<void>;
let server: StartedPreviewServer;
let tmp: string;
const clock = fixedClock("2026-10-14T00:00:00Z");
const logs: string[] = [];

let salesA: Actor;
let ops: Actor;
let versionA: string;
let versionAOld: string;
let tokenA: string;
let tokenB: string;
let tokenDelivery: string;

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** 生のパスのまま送る（fetch は `..` を正規化してしまうため node:http を使う） */
function send(rawPath: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        path: rawPath,
        method: opts.method ?? "GET",
        headers: opts.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function issue(actor: Actor, purpose: "proposal" | "delivery", targetId: string): Promise<string> {
  const r = await issueShareLink(db, clock, actor, { purpose, targetId });
  if (!r.ok) throw new Error(`issue failed: ${r.error}`);
  return r.value.token;
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  tmp = await mkdtemp(path.join(tmpdir(), "siteoffer-preview-test-"));
  const dir = (...p: string[]) => path.join(tmp, ...p);

  // 企業Aの承認済みの版
  await mkdir(dir("a", "about"), { recursive: true });
  await mkdir(dir("a", "images"), { recursive: true });
  await writeFile(dir("a", "index.html"), "<!doctype html><html><head></head><body><h1>COMPANY-A</h1></body></html>");
  await writeFile(
    dir("a", "about", "index.html"),
    '<html><body><div data-demo-notice="top">非公式</div>ABOUT-A</body></html>',
  );
  await writeFile(dir("a", "style.css"), "body{color:red}");
  await writeFile(dir("a", "images", "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  await writeFile(dir("a", "unknown.bin"), "BIN");
  await writeFile(dir("a", ".env"), "SECRET=1");
  await symlink(dir("b", "index.html"), dir("a", "link-out")); // 外への絶対リンク
  await symlink("../b", dir("a", "dir-out")); // 外への相対リンク（ディレクトリ）
  await symlink("style.css", dir("a", "link-in")); // 中へのリンク（許可）
  // 企業Aの別の版（承認されていない）
  await mkdir(dir("a-old"), { recursive: true });
  await writeFile(dir("a-old", "index.html"), "OLD-VERSION-A");
  // 企業B
  await mkdir(dir("b"), { recursive: true });
  await writeFile(dir("b", "index.html"), "<html><body>COMPANY-B-SECRET</body></html>");
  // 成果物ディレクトリの外
  await writeFile(dir("outside.txt"), "OUTSIDE");
  // 納品の版
  await mkdir(dir("d"), { recursive: true });
  await writeFile(dir("d", "index.html"), "<html><body>DELIVERY</body></html>");

  const a = await seedUser(db, "sales");
  const b = await seedUser(db, "sales");
  salesA = a.actor;
  ops = (await seedUser(db, "ops")).actor;
  const companyA = (await seedCompany(db)).id;
  const companyB = (await seedCompany(db)).id;
  await seedAssignment(db, companyA, a.user.id);
  await seedAssignment(db, companyB, b.user.id);
  versionA = (await seedProposalVersion(db, companyA, { artifactDir: dir("a") })).id;
  versionAOld = (await seedProposalVersion(db, companyA, { status: "in_review", artifactDir: dir("a-old") })).id;
  const versionB = (await seedProposalVersion(db, companyB, { artifactDir: dir("b") })).id;
  tokenA = await issue(salesA, "proposal", versionA);
  tokenB = await issue(b.actor, "proposal", versionB);
  const [asg] = await db.select().from(assignments).where(eq(assignments.companyId, companyA));
  const dv = await seedDeliveryVersion(db, companyA, asg!.id, a.user.id, dir("d"));
  tokenDelivery = await issue(ops, "delivery", dv.id);

  server = await startPreviewServer({ db, clock, port: 0, log: (m) => logs.push(m) });
});

afterAll(async () => {
  await server?.close();
  await closeDb?.();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("配信", () => {
  it("有効なリンクで対象の版の index.html を返す", async () => {
    const r = await send(`/s/${tokenA}/`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.body).toContain("COMPANY-A");
  });

  it("末尾の / が無ければ付けてリダイレクトする（相対リンクのため）", async () => {
    expect(await send(`/s/${tokenA}`)).toMatchObject({ status: 308, headers: { location: `/s/${tokenA}/` } });
    expect(await send(`/s/${tokenA}/about`)).toMatchObject({
      status: 308,
      headers: { location: `/s/${tokenA}/about/` },
    });
    expect((await send(`/s/${tokenA}/about/`)).body).toContain("ABOUT-A");
  });

  it("拡張子から Content-Type を決め、不明なものは octet-stream", async () => {
    expect((await send(`/s/${tokenA}/style.css`)).headers["content-type"]).toBe("text/css; charset=utf-8");
    expect((await send(`/s/${tokenA}/images/logo.svg`)).headers["content-type"]).toBe("image/svg+xml");
    expect((await send(`/s/${tokenA}/unknown.bin`)).headers["content-type"]).toBe("application/octet-stream");
    expect((await send(`/s/${tokenA}/style.css?v=1`)).body).toBe("body{color:red}");
  });

  it("成果物ディレクトリの中を指すシンボリックリンクはたどれる", async () => {
    expect((await send(`/s/${tokenA}/link-in`)).body).toBe("body{color:red}");
  });

  it("HEAD は本文なし、GET・HEAD 以外は 405", async () => {
    const h = await send(`/s/${tokenA}/style.css`, { method: "HEAD" });
    expect(h.status).toBe(200);
    expect(h.body).toBe("");
    expect(h.headers["content-length"]).toBe(String("body{color:red}".length));
    const p = await send(`/s/${tokenA}/`, { method: "POST" });
    expect(p.status).toBe(405);
    expect(p.headers.allow).toBe("GET, HEAD");
  });

  it("提案デモに非公式表示が無ければ差し込み、あれば二重にしない。納品の版には差し込まない", async () => {
    const top = await send(`/s/${tokenA}/`);
    expect(top.body).toMatch(/<body><div role="note" data-demo-notice="preview"[^>]*>これは非公式の改善提案デモです/);
    const about = await send(`/s/${tokenA}/about/`);
    expect(about.body.match(/data-demo-notice/g)).toHaveLength(1);
    const delivery = await send(`/s/${tokenDelivery}/`);
    expect(delivery.status).toBe(200);
    expect(delivery.body).toBe("<html><body>DELIVERY</body></html>");
  });
});

describe("他企業・他の版・成果物の外に到達できない（AC-14）", () => {
  const traversals = [
    "/../b/index.html",
    "/../outside.txt",
    "/%2e%2e/b/index.html",
    "/%2E%2E/%2E%2E/outside.txt",
    "/..%2fb%2findex.html",
    "/..%2Foutside.txt",
    "/%2e%2e%2fb%2findex.html",
    "/..%5cb%5cindex.html",
    "/..\\b\\index.html",
    "/%2fetc%2fpasswd",
    "//etc/passwd",
    "/./index.html",
    "/about/../../b/index.html",
    "/%252e%252e/b/index.html",
    "/index.html%00.css",
    "/link-out",
    "/dir-out/index.html",
    "/dir-out/",
    "/.env",
    "/%2eenv",
    "/../a-old/index.html",
    "/%c0%ae%c0%ae/b/index.html",
  ];

  it.each(traversals)("%s は 404", async (p) => {
    const n = logs.length;
    const r = await send(`/s/${tokenA}${p}`);
    expect(r.status).toBe(404);
    expect(r.body).not.toMatch(/COMPANY-B|OUTSIDE|OLD-VERSION|SECRET|root:/);
    // 生のパスのままサーバーに届き、トークンの検証を通った後のファイル解決で拒否されたこと
    expect(logs.slice(n).join("\n")).toMatch(/not found \((bad_path|outside_root|missing)\)/);
  });

  it("企業Bのリンクでは企業Bの成果物だけが見え、企業Aのファイルには届かない", async () => {
    expect((await send(`/s/${tokenB}/`)).body).toContain("COMPANY-B-SECRET");
    expect((await send(`/s/${tokenB}/style.css`)).status).toBe(404);
    expect((await send(`/s/${tokenB}/../a/style.css`)).status).toBe(404);
  });

  it("承認されていない版を指すリンク（DBに直接作ったもの）は 404", async () => {
    const token = "o".repeat(43);
    const [l] = await db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.tokenHash, hashShareToken(tokenA)));
    await db.insert(shareLinks).values({
      tokenHash: hashShareToken(token),
      purpose: "proposal",
      companyId: l!.companyId,
      targetId: versionAOld,
      expiresAt: new Date(clock.now().getTime() + HOUR),
      createdBy: l!.createdBy,
    });
    const r = await send(`/s/${token}/`);
    expect(r.status).toBe(404);
    expect(r.body).not.toContain("OLD-VERSION");
  });

  it("/s/ 以外のパスと不正な形式のトークンは 404", async () => {
    for (const p of ["/", "/index.html", "/s/", "/s/short/", `/s/${tokenA}x/`, `/x/${tokenA}/`, "/s/%2e%2e/"]) {
      expect((await send(p)).status).toBe(404);
    }
  });
});

describe("ヘッダー（11章：別オリジン・Cookieを扱わない）", () => {
  const expectSecurityHeaders = (r: Res) => {
    const csp = String(r.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'self' http://localhost:3100");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(String(r.headers["x-robots-tag"])).toContain("noindex");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["set-cookie"]).toBeUndefined();
  };

  it("200・404・308・405 のすべてに付け、Set-Cookie を返さない", async () => {
    expectSecurityHeaders(await send(`/s/${tokenA}/`));
    expectSecurityHeaders(await send(`/s/${tokenA}/style.css`));
    expectSecurityHeaders(await send(`/s/${tokenA}/nope.html`));
    expectSecurityHeaders(await send("/s/unknown/"));
    expectSecurityHeaders(await send(`/s/${tokenA}`));
    expectSecurityHeaders(await send(`/s/${tokenA}/`, { method: "POST" }));
  });

  it("アプリのCookieを送られても使わず、そのまま返しもしない", async () => {
    const r = await send(`/s/${tokenA}/`, { headers: { Cookie: "siteoffer_session=abc123" } });
    expect(r.status).toBe(200);
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.body).not.toContain("abc123");
    // Cookie だけでは（トークンなしでは）何も見えない
    expect((await send("/s/", { headers: { Cookie: "siteoffer_session=abc123" } })).status).toBe(404);
  });
});

describe("期限切れ・取り消し（AC-14）", () => {
  it("期限切れ・取り消し済み・不明なトークンは同じ 404（存在を明かさない）", async () => {
    const tExpire = await issue(salesA, "proposal", versionA);
    const tRevoke = await issue(salesA, "proposal", versionA);
    expect((await send(`/s/${tExpire}/`)).status).toBe(200);
    expect((await send(`/s/${tRevoke}/`)).status).toBe(200);

    const [link] = await db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.tokenHash, hashShareToken(tRevoke)));
    expect((await revokeShareLink(db, clock, salesA, link!.id)).ok).toBe(true);
    const revoked = await send(`/s/${tRevoke}/style.css`);
    const unknown = await send(`/s/${"z".repeat(43)}/style.css`);
    expect(revoked.status).toBe(404);
    expect(revoked.body).toBe(unknown.body);
    expect(revoked.headers["content-type"]).toBe(unknown.headers["content-type"]);

    const before = clock.now();
    try {
      clock.advance(24 * 14 * HOUR); // 既定の有効期間ちょうど
      const expired = await send(`/s/${tExpire}/`);
      expect(expired.status).toBe(404);
      expect(expired.body).toBe(unknown.body);
    } finally {
      clock.set(before);
    }
    // ログには理由が残るが、トークンは書かない
    expect(logs.some((l) => l.includes("revoked"))).toBe(true);
    expect(logs.some((l) => l.includes("expired"))).toBe(true);
    expect(logs.join("\n")).not.toContain(tExpire);
    expect(logs.join("\n")).not.toContain(tRevoke);
  });
});
