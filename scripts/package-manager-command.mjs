export function resolvePnpmCommand(env = process.env, platform = process.platform) {
  const npmExecPath = env.npm_execpath?.trim();
  if (npmExecPath) {
    return {
      command: process.execPath,
      prefixArgs: [npmExecPath],
    };
  }

  return {
    command: platform === "win32" ? "pnpm.cmd" : "pnpm",
    prefixArgs: [],
  };
}
