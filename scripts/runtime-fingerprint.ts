import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeKind = "codex" | "site";
export const RUNTIME_SOURCE_LABEL = "org.siteoffer.runtime.source-sha256";
export const RUNTIME_KIND_LABEL = "org.siteoffer.runtime.kind";
export const RUNTIME_SOURCES: Record<RuntimeKind, readonly string[]> = {
  codex: ["Dockerfile.codex", "scripts/runtime-fingerprint.ts", "packages/generation/src/sandbox"],
  site: [
    "Dockerfile.site",
    "scripts/runtime-fingerprint.ts",
    "tsconfig.base.json",
    "templates/astro-site/astro.config.ts",
    ...["build", "check", "lib", "schema", "src", "runtime"].map((dir) => `templates/astro-site/${dir}`),
  ],
};
export const runtimeRepoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Hash copied sources, normalizing text line endings across Windows and Linux. */
export async function runtimeSourceFingerprint(kind: RuntimeKind, root = runtimeRepoRoot): Promise<string> {
  const files: string[] = [];
  async function visit(relative: string) {
    const name = path.basename(relative);
    if (
      ["node_modules", "dist", ".astro", "__pycache__", ".data", "reports", "coverage", "auth.json"].includes(name) ||
      name.startsWith(".next") ||
      name === ".env" ||
      name.startsWith(".env.") ||
      /\.(?:pem|key|pyc)$/.test(name)
    )
      return;
    const file = path.join(root, relative);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error("Runtime source must not be a symbolic link");
    if (info.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await visit(`${relative}/${name}`);
    } else if (info.isFile()) files.push(relative);
    else throw new Error("Unsupported runtime source");
  }
  for (const source of RUNTIME_SOURCES[kind]) await visit(source);
  const digest = createHash("sha256").update(`siteoffer-runtime-v1\0${kind}\0`);
  for (const file of files.sort()) {
    const raw = await readFile(path.join(root, file));
    const text = /\.(?:ts|js|mjs|json|astro|css|svg|md)$/.test(file) || path.basename(file).startsWith("Dockerfile.");
    const bytes = text ? Buffer.from(raw.toString("utf8").replaceAll("\r\n", "\n")) : raw;
    digest.update(`${file}\0${bytes.length}\0`).update(bytes);
  }
  return digest.digest("hex");
}

export function runtimeLabelsMatch(labels: unknown, kind: RuntimeKind, fingerprint: string): boolean {
  if (!labels || typeof labels !== "object" || Array.isArray(labels) || !/^[a-f0-9]{64}$/.test(fingerprint))
    return false;
  const values = labels as Record<string, unknown>;
  return values[RUNTIME_KIND_LABEL] === kind && values[RUNTIME_SOURCE_LABEL] === fingerprint;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const kind = process.argv[2];
  if (kind !== "codex" && kind !== "site") throw new Error("Runtime kind must be codex or site");
  const fingerprint = await runtimeSourceFingerprint(kind, process.argv[3] || runtimeRepoRoot);
  if (process.argv[4] !== fingerprint)
    throw new Error("Runtime source mismatch. Build using pnpm runtime:build, codex:build or site:build.");
  console.log(JSON.stringify({ schemaVersion: 1, kind, sha256: fingerprint }));
}
