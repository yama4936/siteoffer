/** npm_execpath can point to a JavaScript CLI or a standalone pnpm executable. */
export function pnpmCommand(
  args: readonly string[],
  cli = process.env.npm_execpath,
  node = process.execPath,
): { command: string; args: string[] } {
  if (!cli) return { command: "pnpm", args: [...args] };
  if (/\.(?:js|cjs|mjs)$/i.test(cli)) return { command: node, args: [cli, ...args] };
  return { command: cli, args: [...args] };
}
