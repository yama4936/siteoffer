import path from "node:path";

// Import paths only after selecting the verified recovery profile.
if (process.argv.length !== 3) throw new Error("pnpm demo:restored <復元フォルダー> を使ってください。");
process.env.DEMO_RESTORE_DIR = path.resolve(process.argv[2]!);
await import("./run.ts");
