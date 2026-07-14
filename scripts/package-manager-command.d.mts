export interface PackageManagerCommand {
  command: string;
  prefixArgs: string[];
}

export function resolvePnpmCommand(
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform | string,
): PackageManagerCommand;
