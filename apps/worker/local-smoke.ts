import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { claimAssignment, createLocalAuthProvider, issueShareLink, systemClock } from "@siteoffer/core";
import { companies, createDb, discoveryJobs, productTerms, proposals, proposalVersions } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import { createDiscoveryJobByOps, makeSellable, reviewProposalVersion } from "../web/lib/ops/commands.ts";

const base = "http://localhost:3100";
const credentials = JSON.parse(await readFile(new URL("../../.data/demo/users.json", import.meta.url), "utf8"));
const { db, close } = createDb("postgres://postgres@127.0.0.1:15439/postgres");
const auth = createLocalAuthProvider({ db, clock: systemClock });
const sessions: any[] = [];
const results: object[] = [];
try {
  for (const email of ["ops@example.test", "sales@example.test", "sales2@example.test"]) {
    const cred = credentials.find((c: any) => c.email === email);
    const result = await auth.login({ email, password: cred.password });
    assert(result.ok, `Login failed: ${email}`);
    sessions.push(result.value);
  }
  const [ops, sales, sales2] = sessions;
  if (!process.argv.includes("--finish")) {
    for (const route of ["/login", "/register"]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      results.push({ route, status: response.status });
    }
    for (const route of ["/ops", "/sales/companies"]) {
      const response = await fetch(base + route, { redirect: "manual" });
      assert.equal(response.status, 307, `Unauthenticated ${route}`);
    }
    for (const [session, routes] of [
      [
        ops,
        [
          "/ops",
          "/ops/discovery",
          "/ops/review",
          "/ops/assignments",
          "/ops/contracts",
          "/ops/delivery",
          "/ops/settings",
        ],
      ],
      [sales, ["/sales/companies", "/sales/assignments", "/sales/earnings"]],
    ] as const) {
      for (const route of routes) {
        const response = await fetch(base + route, {
          headers: { Cookie: `siteoffer_session=${session.token}` },
          redirect: "manual",
        });
        assert.equal(response.status, 200, route);
        assert((await response.text()).includes("SiteOffer"), route);
        results.push({ route, status: response.status });
        console.log(`PASS ${route}`);
      }
    }
    const forbidden = await fetch(base + "/ops", {
      headers: { Cookie: `siteoffer_session=${sales.token}` },
      redirect: "manual",
    });
    assert.equal(forbidden.status, 307);
    assert.equal(new URL(forbidden.headers.get("location")!, base).pathname, "/");
    const jobs = await db.select().from(discoveryJobs);
    if (!jobs.length) {
      const created = await createDiscoveryJobByOps({ db, clock: systemClock }, ops.user.actor, {
        provider: "fixture",
        criteria: { prefecture: "愛知県", city: "名古屋市", limit: 50 },
      });
      assert(created.ok, "Could not queue fixture discovery");
      console.log(`Fixture discovery queued: ${created.value.jobId}`);
    }
    await writeFile(
      new URL("../../.data/local-run/http-check.json", import.meta.url),
      JSON.stringify(
        { checkedAt: new Date().toISOString(), results, roleBoundary: "pass", mode: "mock/PGlite" },
        null,
        2,
      ),
    );
  } else {
    const rows = await db
      .select({ company: companies, version: proposalVersions })
      .from(proposalVersions)
      .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
      .innerJoin(companies, eq(companies.id, proposals.companyId));
    assert.equal((await db.select().from(companies)).length, 6, "Expected six fixture companies");
    assert.equal(rows.length, 3, "Expected three generated proposal versions");
    const [terms] = await db.select().from(productTerms);
    for (const { company, version } of rows) {
      assert(
        ["in_review", "approved"].includes(version.status),
        `Proposal not ready: ${company.name}: ${version.status}`,
      );
      if (version.status === "in_review") {
        const approved = await reviewProposalVersion({ db, clock: systemClock }, ops.user.actor, {
          proposalVersionId: version.id,
          decision: "approved",
          note: "ローカルの架空デモ動作確認。実企業の品質承認ではありません。",
        });
        assert(approved.ok, "Demo approval failed");
      }
      if (company.pipelineStatus !== "sellable") {
        const sellable = await makeSellable({ db, clock: systemClock }, ops.user.actor, {
          companyId: company.id,
          productTermsId: terms!.id,
        });
        assert(sellable.ok, "Demo make sellable failed");
      }
    }
    const selected = rows.find((r) => r.company.name.includes("あおば")) ?? rows[0]!;
    const assignment = await claimAssignment(db, systemClock, sales.user.actor, selected.company.id);
    assert(assignment.ok || assignment.error === "already_assigned", "Claim failed");
    const duplicate = await claimAssignment(db, systemClock, sales2.user.actor, selected.company.id);
    assert(!duplicate.ok && duplicate.error === "already_assigned", "Duplicate claim was not blocked");
    const shared = await issueShareLink(db, systemClock, sales.user.actor, {
      purpose: "proposal",
      targetId: selected.version.id,
    });
    assert(shared.ok, "Could not issue local demo preview link");
    const previewUrl = `http://localhost:3200/s/${shared.value.token}/`;
    const preview = await fetch(previewUrl);
    assert.equal(preview.status, 200, "Preview HTTP status");
    const html = await preview.text();
    assert(html.includes("あおば工務店"), "Preview company content");
    assert(html.includes("noindex"), "Preview noindex");
    const detail = await fetch(`${base}/sales/companies/${selected.company.id}`, {
      headers: { Cookie: `siteoffer_session=${sales.token}` },
    });
    assert.equal(detail.status, 200);
    const output = {
      checkedAt: new Date().toISOString(),
      mode: "mock/PGlite",
      companies: 6,
      generated: 3,
      sellable: 3,
      duplicateClaim: "blocked",
      companyUrl: `${base}/sales/companies/${selected.company.id}`,
      previewUrl,
      previewStatus: preview.status,
    };
    await writeFile(new URL("../../.data/local-run/flow-check.json", import.meta.url), JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output, null, 2));
  }
} finally {
  for (const session of sessions) await auth.logout(session.token);
  await close();
}
