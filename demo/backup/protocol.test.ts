import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type PGliteServer, startPGliteServer } from "../../packages/db/src/pglite-server.ts";
import { pgliteRuntime } from "./runtime.ts";

interface Client {
  on(event: "error", listener: (error: Error) => void): this;
  connect(): Promise<void>;
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
const fromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url)),
  { Client } = fromDb("pg") as { Client: new (options: Record<string, unknown>) => Client };
const runtime = pgliteRuntime();
let db: Awaited<ReturnType<typeof runtime.PGlite.create>>, server: PGliteServer, clients: Client[];
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
beforeEach(async () => {
  clients = [];
  db = await runtime.PGlite.create();
  await db.query("create table checkpoint_probe(id int primary key)");
  server = await startPGliteServer(db, { host: "127.0.0.1", port: 0 });
});
afterEach(async () => {
  await Promise.allSettled(clients.map((c) => c.end()));
  await server.stop();
  await db.close();
});
async function client() {
  const c = new Client({
    host: "127.0.0.1",
    port: server.port,
    user: "postgres",
    database: "postgres",
    connectionTimeoutMillis: 5000,
  });
  await c.connect();
  clients.push(c);
  return c;
}
it("waits for an open transaction, then reserves the DB before a later socket query", async () => {
  const a = await client(),
    b = await client();
  await a.query("begin");
  await a.query("insert into checkpoint_probe values(1)");
  let entered = false;
  const held = gate();
  const read = server.exclusive(async () => {
    entered = true;
    await held.promise;
    return db.query<{ n: number }>("select count(*)::int n from checkpoint_probe");
  });
  let later = false;
  const write = b.query("insert into checkpoint_probe values(2)").then(() => {
    later = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(entered).toBe(false);
  expect(later).toBe(false);
  await a.query("commit");
  for (let i = 0; i < 100 && !entered; i++) await new Promise((r) => setTimeout(r, 5));
  expect(entered).toBe(true);
  expect(later).toBe(false);
  held.resolve();
  expect((await read).rows[0]!.n).toBe(1);
  await write;
  expect((await b.query("select count(*)::int n from checkpoint_probe")).rows[0]!.n).toBe(2);
});
it("cancels a queued reservation without running it or leaving the next request blocked", async () => {
  const a = await client(),
    b = await client();
  await a.query("begin");
  let entered = false;
  const controller = new AbortController(),
    read = server.exclusive(async () => {
      entered = true;
    }, controller.signal),
    rejected = expect(read).rejects.toBeDefined();
  controller.abort();
  await rejected;
  await a.query("commit");
  await b.query("insert into checkpoint_probe values(1)");
  expect(entered).toBe(false);
});
it("retains the reservation until an uninterruptible operation actually finishes", async () => {
  const b = await client(),
    entered = gate(),
    held = gate(),
    controller = new AbortController();
  let settled = false;
  const read = server.exclusive(async (signal) => {
    entered.resolve();
    await held.promise;
    signal.throwIfAborted();
  }, controller.signal);
  const result = read.finally(() => {
    settled = true;
  });
  const rejected = expect(result).rejects.toBeDefined();
  await entered.promise;
  controller.abort();
  let finished = false;
  const query = b.query("select 1").then(() => {
    finished = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(settled).toBe(false);
  expect(finished).toBe(false);
  held.resolve();
  await rejected;
  await query;
});
it("server shutdown aborts queued host work and closes active protocol clients", async () => {
  const a = await client();
  const disconnected = new Promise<Error>((resolve) => a.on("error", resolve));
  await a.query("begin");
  let entered = false;
  const read = server.exclusive(async () => {
    entered = true;
  });
  const rejected = expect(read).rejects.toBeDefined();
  await server.stop();
  await rejected;
  expect((await disconnected).message).toContain("terminated");
  expect((await db.query<{ n: number }>("select count(*)::int n from checkpoint_probe")).rows[0]!.n).toBe(0);
  expect(entered).toBe(false);
});
