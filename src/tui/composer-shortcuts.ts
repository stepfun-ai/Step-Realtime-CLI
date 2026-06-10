interface ComposerShortcutKey {
  ctrl?: boolean;
  meta?: boolean;
  name?: string;
  raw?: string;
  sequence?: string;
  shift?: boolean;
  super?: boolean;
}

const LEGACY_NEWLINE_SEQUENCES = new Set([
  "\n",
  "\u001b\r",
  "\u001b[13;2u",
  "[13;2u",
  "\u001b[13;2~",
  "[13;2~",
  "\u001b[27;2;13~",
  "[27;2;13~",
]);

export function isComposerNewlineKey(key: ComposerShortcutKey): boolean {
  if (key.name === "linefeed") {
    return true;
  }

  if ((key.ctrl && key.name === "j") || (key.name === "return" && key.shift)) {
    return true;
  }

  const sequence = key.sequence || key.raw;
  return sequence ? LEGACY_NEWLINE_SEQUENCES.has(sequence) : false;
}

export function isComposerSubmitKey(key: ComposerShortcutKey): boolean {
  return (
    key.name === "return" && !key.shift && !key.ctrl && !key.meta && !key.super
  );
}
