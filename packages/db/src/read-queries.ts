import { is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { DbOrTx } from "./db.ts";

type Reads = readonly (() => unknown)[];
type ReadResults<T extends Reads> = { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };

/** Pool reads may overlap; a transaction owns one client and must start each read in order. */
export async function runReadQueries<const T extends Reads>(db: DbOrTx, reads: T): Promise<ReadResults<T>> {
  if (!is(db, PgTransaction)) return Promise.all(reads.map((read) => read())) as Promise<ReadResults<T>>;
  const results: unknown[] = [];
  for (const read of reads) results.push(await read());
  return results as ReadResults<T>;
}
