export function pnpmInvocation(
  args,
  {
    platform = process.platform,
    execPath = process.execPath,
    pnpmEntry = process.env.npm_execpath,
  } = {},
) {
  if (platform !== "win32") return { command: "pnpm", args };
  if (!pnpmEntry || !/\.(?:cjs|mjs|js)$/i.test(pnpmEntry))
    throw new Error("Run this command through pnpm on Windows to provide its JavaScript entry.");
  return { command: execPath, args: [pnpmEntry, ...args] };
}
