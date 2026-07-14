export function resolvePnpmCommand(
  env = process.env,
  platform = process.platform,
) {
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

export function resolveCommandInvocation(
  command,
  args = [],
  platform = process.platform,
  env = process.env,
) {
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", quoteWindowsCommand([command, ...args])],
    };
  }

  return {
    command,
    args,
  };
}

function quoteWindowsCommand(parts) {
  return parts.map(quoteWindowsArg).join(" ");
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (text.length === 0) {
    return '""';
  }

  if (!/[\s"&|<>^]/.test(text)) {
    return text;
  }

  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, "$&$&")}"`;
}
