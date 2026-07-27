const REDOS_PATTERNS = [
  /\([^)]*[+*][^)]*\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/,
  /\(\S*(?:\|.*){2,}\)\s*[+*]/,
  /\((?:\w|\|){2,}\)\s*\+/,
  /\(.*\)\s*\{\d+,\}/,
];

export function createSafeGrepRegex(pattern: string): RegExp | null {
  try {
    if (REDOS_PATTERNS.some((rule) => rule.test(pattern))) return null;
    return new RegExp(pattern);
  } catch {
    return null;
  }
}
