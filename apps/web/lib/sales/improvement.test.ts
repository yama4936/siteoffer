// 改良資料・改善後サイトの読み取りの結合テスト（PGlite と一時ディレクトリ）。
// 企業名・URL・ファイルの中身はテスト内だけの架空の値。
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Actor, claimAssignment, fixedClock } from "@siteoffer/core";
import { companies, type Db, siteAudits, users, websites } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  contentTypeFor,
  getImprovementAvailability,
  getImprovementSource,
  parseSitePath,
  readProposalMarkdown,
  readSiteFile,
  serveImprovedSite,
  siteSecurityHeaders,
} from "./improvement.ts";

let db: Db;
let close: () => Promise<void>;
let tmp: string;
let seq = 0;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  tmp = await mkdtemp(path.join(tmpdir(), "siteoffer-improvement-"));
});
afterEach(async () => {
  await close();
  await rm(tmp, { recursive: true, force: true });
});

async function user(role: "sales" | "ops") {
  seq++;
  const [u] = await db
    .insert(users)
    .values({ email: `${role}${seq}@example.test`, passwordHash: "x", displayName: `${role}${seq}`, role })
    .returning();
  return { id: u!.id, actor: { kind: role, userId: u!.id } as Actor };
}

/** 企業・サイト・評価済み診断を作る。artifactDir に成果物ディレクトリを入れる */
async function companyWithAudit(
  pipelineStatus: "sellable" | "audited" | "on_hold" = "sellable",
  artifactDir: string | null = null,
) {
  seq++;
  const [c] = await db
    .insert(companies)
    .values({ name: `架空工務店${seq}`, pipelineStatus })
    .returning();
  const [w] = await db
    .insert(websites)
    .values({
      companyId: c!.id,
      url: `https://example${seq}.test/`,
      normalizedUrl: `example${seq}.test/`,
      domain: `example${seq}.test`,
      isPrimary: true,
    })
    .returning();
  await db.insert(siteAudits).values({
    companyId: c!.id,
    websiteId: w!.id,
    status: "evaluated",
    targetUrl: `https://example${seq}.test/`,
    totalScore: "48.5",
    scoreConfirmed: true,
    artifactDir,
  });
  return c!;
}

/** 成果物ディレクトリ（proposal.md と site/）を作る */
async function artifact(name = "a") {
  const dir = path.join(tmp, name);
  await mkdir(path.join(dir, "site", "assets"), { recursive: true });
  await mkdir(path.join(dir, "site", "about"), { recursive: true });
  await writeFile(path.join(dir, "proposal.md"), "# 改善提案書\n\n本文");
  await writeFile(path.join(dir, "site", "index.html"), "<!doctype html><p>top</p>");
  await writeFile(path.join(dir, "site", "about", "index.html"), "<p>about</p>");
  await writeFile(path.join(dir, "site", "assets", "style.css"), "body{}");
  await writeFile(path.join(dir, "site", ".secret"), "hidden");
  await writeFile(path.join(dir, "evaluation.json"), "{}");
  return dir;
}

const sitePath = (companyId: string, rest = "") => `/sales/companies/${companyId}/site${rest}`;

describe("権限", () => {
  it("未ログインは forbidden", async () => {
    const c = await companyWithAudit("sellable", await artifact());
    expect(await getImprovementSource(db, null, c.id)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await serveImprovedSite(db, null, c.id, sitePath(c.id, "/index.html"))).toMatchObject({
      ok: false,
      error: "forbidden",
    });
  });

  it("営業可能でない企業は not_found（存在を明かさない）", async () => {
    const me = await user("sales");
    const c = await companyWithAudit("audited", await artifact());
    expect(await getImprovementSource(db, me.actor, c.id)).toMatchObject({ ok: false, error: "not_found" });
    expect(await serveImprovedSite(db, me.actor, c.id, sitePath(c.id, "/index.html"))).toEqual({
      ok: true,
      value: { kind: "not_found" },
    });
  });

  it("存在しない・形式違いのIDは not_found", async () => {
    const me = await user("sales");
    expect(await getImprovementSource(db, me.actor, "00000000-0000-4000-8000-000000000000")).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await getImprovementSource(db, me.actor, "../etc")).toMatchObject({ ok: false, error: "not_found" });
  });

  it("営業可能な企業は読める。自分の担当になった企業は営業可能でなくなっても読める（企業詳細と同じ）", async () => {
    const me = await user("sales");
    const dir = await artifact();
    const c = await companyWithAudit("sellable", dir);
    const r = await getImprovementSource(db, me.actor, c.id);
    expect(r.ok && r.value.artifactDir).toBe(dir);
    expect(r.ok && r.value.audit?.totalScore).toBe("48.5");

    const claimed = await claimAssignment(db, fixedClock("2026-10-14T00:00:00Z"), me.actor, c.id);
    expect(claimed.ok).toBe(true);
    await db.update(companies).set({ pipelineStatus: "on_hold" }).where(eq(companies.id, c.id));
    expect((await getImprovementSource(db, me.actor, c.id)).ok).toBe(true);
    const other = await user("sales");
    expect(await getImprovementSource(db, other.actor, c.id)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("相対パスの artifactDir は使わない", async () => {
    const me = await user("sales");
    const c = await companyWithAudit("sellable", "reports/sites/example.test/2026-10-14");
    const r = await getImprovementSource(db, me.actor, c.id);
    expect(r.ok && r.value.artifactDir).toBeNull();
  });
});

describe("改良資料", () => {
  it("proposal.md を読む。無ければ null", async () => {
    const dir = await artifact();
    expect(await readProposalMarkdown(dir)).toContain("改善提案書");
    await rm(path.join(dir, "proposal.md"));
    expect(await readProposalMarkdown(dir)).toBeNull();
    expect(await readProposalMarkdown(path.join(tmp, "missing"))).toBeNull();
  });

  it("成果物ディレクトリの外を指す proposal.md のリンクは読まない", async () => {
    const dir = path.join(tmp, "x");
    await mkdir(dir);
    await writeFile(path.join(tmp, "outside.md"), "外のファイル");
    await symlink(path.join(tmp, "outside.md"), path.join(dir, "proposal.md"));
    expect(await readProposalMarkdown(dir)).toBeNull();
  });

  it("ファイルの有無を返す", async () => {
    const dir = await artifact();
    expect(await getImprovementAvailability(dir)).toEqual({ hasProposal: true, hasSite: true });
    expect(await getImprovementAvailability(null)).toEqual({ hasProposal: false, hasSite: false });
    const empty = path.join(tmp, "empty");
    await mkdir(empty);
    expect(await getImprovementAvailability(empty)).toEqual({ hasProposal: false, hasSite: false });
  });
});

describe("改善後サイトの配信", () => {
  it("ルート・ディレクトリの末尾スラッシュは index.html を返す", async () => {
    const dir = await artifact();
    const top = await readSiteFile(dir, "/");
    expect(top.kind === "file" && top.body.toString()).toContain("top");
    expect(top.kind === "file" && top.contentType).toBe("text/html; charset=utf-8");
    const about = await readSiteFile(dir, "/about/");
    expect(about.kind === "file" && about.body.toString()).toContain("about");
    const css = await readSiteFile(dir, "/assets/style.css");
    expect(css.kind === "file" && css.contentType).toBe("text/css; charset=utf-8");
    expect(await readSiteFile(dir, "/about")).toEqual({ kind: "redirect_index" });
  });

  it("`/site` とディレクトリは index.html へリダイレクトする", async () => {
    const me = await user("sales");
    const c = await companyWithAudit("sellable", await artifact());
    expect(await serveImprovedSite(db, me.actor, c.id, sitePath(c.id))).toEqual({
      ok: true,
      value: { kind: "redirect", location: sitePath(c.id, "/index.html") },
    });
    expect(await serveImprovedSite(db, me.actor, c.id, sitePath(c.id, "/about"))).toEqual({
      ok: true,
      value: { kind: "redirect", location: sitePath(c.id, "/about/index.html") },
    });
    const r = await serveImprovedSite(db, me.actor, c.id, sitePath(c.id, "/index.html"));
    expect(r.ok && r.value.kind).toBe("file");
  });

  it("パストラバーサル・ドットファイル・エンコードされた区切りを拒否する", async () => {
    const dir = await artifact();
    for (const p of [
      "/../proposal.md",
      "/assets/../../evaluation.json",
      "/%2e%2e/proposal.md",
      "/..%2fproposal.md",
      "/..%5cproposal.md",
      "/assets%2fstyle.css",
      "/.secret",
      "//etc/passwd",
      "/a\\..\\b",
      "/%00",
      "/%E0%A4%A",
    ]) {
      expect((await readSiteFile(dir, p)).kind, p).toBe("not_found");
    }
    expect(parseSitePath("relative")).toBeNull();
    expect(parseSitePath("/a/./b")).toBeNull();
  });

  it("site の外を指すシンボリックリンクはたどらない", async () => {
    const dir = await artifact();
    await symlink(path.join(dir, "proposal.md"), path.join(dir, "site", "leak.md"));
    await symlink(dir, path.join(dir, "site", "up"));
    expect((await readSiteFile(dir, "/leak.md")).kind).toBe("not_found");
    expect((await readSiteFile(dir, "/up/proposal.md")).kind).toBe("not_found");

    // site 自体が外を指すリンクなら配信しない
    const other = path.join(tmp, "other");
    await mkdir(path.join(other, "real"), { recursive: true });
    await writeFile(path.join(other, "real", "index.html"), "x");
    const linked = path.join(tmp, "linked");
    await mkdir(linked);
    await symlink(path.join(other, "real"), path.join(linked, "site"));
    expect((await readSiteFile(linked, "/index.html")).kind).toBe("not_found");
    expect(await getImprovementAvailability(linked)).toEqual({ hasProposal: false, hasSite: false });
  });

  it("ファイルや site が無ければ not_found", async () => {
    const me = await user("sales");
    const dir = await artifact();
    expect((await readSiteFile(dir, "/nothing.html")).kind).toBe("not_found");
    const empty = path.join(tmp, "empty");
    await mkdir(empty);
    expect((await readSiteFile(empty, "/")).kind).toBe("not_found");
    const noDir = await companyWithAudit("sellable", null);
    expect(await serveImprovedSite(db, me.actor, noDir.id, sitePath(noDir.id, "/index.html"))).toEqual({
      ok: true,
      value: { kind: "not_found" },
    });
  });

  it("他の企業のパスとして来たリクエストは配信しない", async () => {
    const me = await user("sales");
    const a = await companyWithAudit("sellable", await artifact("a"));
    const b = await companyWithAudit("sellable", await artifact("b"));
    expect(await serveImprovedSite(db, me.actor, a.id, sitePath(b.id, "/index.html"))).toEqual({
      ok: true,
      value: { kind: "not_found" },
    });
  });

  it("Content-Type とセキュリティヘッダー", () => {
    expect(contentTypeFor("a/b.PNG")).toBe("image/png");
    expect(contentTypeFor("a/b.exe")).toBe("application/octet-stream");
    const h = siteSecurityHeaders();
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(h["Content-Security-Policy"]).toContain("script-src 'self'");
    expect(h["Content-Security-Policy"]).toContain("connect-src 'none'");
  });
});
