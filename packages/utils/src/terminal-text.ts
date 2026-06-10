export interface SanitizeTerminalTextOptions {
  preserveNewlines?: boolean;
  preserveTabs?: boolean;
}

export function sanitizeTerminalText(
  value: string,
  options: SanitizeTerminalTextOptions = {},
): string {
  if (!value) {
    return "";
  }

  const preserveNewlines = options.preserveNewlines ?? true;
  const preserveTabs = options.preserveTabs ?? true;
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);

    if (code === 0x1b) {
      cursor = consumeEscapeSequence(value, cursor);
      continue;
    }

    if (code === 0x0d) {
      cursor += 1;
      continue;
    }

    if (shouldSkipControlCode(code, preserveNewlines, preserveTabs)) {
      cursor += 1;
      continue;
    }

    const codePoint = value.codePointAt(cursor);
    if (codePoint === undefined) {
      break;
    }

    result += String.fromCodePoint(codePoint);
    cursor += codePoint > 0xffff ? 2 : 1;
  }

  return result;
}

function shouldSkipControlCode(
  code: number,
  preserveNewlines: boolean,
  preserveTabs: boolean,
): boolean {
  if (code === 0x0a) {
    return !preserveNewlines;
  }
  if (code === 0x09) {
    return !preserveTabs;
  }
  return (code >= 0x00 && code <= 0x1f) || code === 0x7f;
}

function consumeEscapeSequence(value: string, start: number): number {
  const next = value.charCodeAt(start + 1);
  if (Number.isNaN(next)) {
    return Math.min(value.length, start + 1);
  }

  if (next === 0x5b) {
    return consumeCsiSequence(value, start + 2);
  }

  if (next === 0x5d) {
    return consumeOscSequence(value, start + 2);
  }

  if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
    return consumeStSequence(value, start + 2);
  }

  if ((next === 0x4f || next === 0x4e) && start + 2 < value.length) {
    return start + 3;
  }

  let cursor = start + 1;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    cursor += 1;
    if (code >= 0x30 && code <= 0x7e) {
      return cursor;
    }
  }

  return value.length;
}

function consumeCsiSequence(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    cursor += 1;
    if (code >= 0x40 && code <= 0x7e) {
      return cursor;
    }
  }
  return value.length;
}

function consumeOscSequence(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    if (code === 0x07) {
      return cursor + 1;
    }
    if (code === 0x1b && value.charCodeAt(cursor + 1) === 0x5c) {
      return cursor + 2;
    }
    cursor += 1;
  }
  return value.length;
}

function consumeStSequence(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length) {
    if (
      value.charCodeAt(cursor) === 0x1b &&
      value.charCodeAt(cursor + 1) === 0x5c
    ) {
      return cursor + 2;
    }
    cursor += 1;
  }
  return value.length;
}
