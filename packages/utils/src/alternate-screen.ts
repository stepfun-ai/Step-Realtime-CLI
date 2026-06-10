export function resolveAlternateScreenMode(
  argv: string[],
  configDefault?: boolean,
  stdoutIsTTY: boolean = process.stdout.isTTY,
): boolean {
  if (argv.includes("--no-alt-screen")) {
    return false;
  }
  if (argv.includes("--alt-screen")) {
    return true;
  }
  if (configDefault !== undefined) {
    return configDefault;
  }
  return inferDefaultAlternateScreenMode(stdoutIsTTY);
}

export function inferDefaultAlternateScreenMode(
  stdoutIsTTY: boolean = process.stdout.isTTY,
): boolean {
  return stdoutIsTTY;
}
