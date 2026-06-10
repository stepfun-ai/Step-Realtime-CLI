export interface StepCliTuiSelectionReader {
  getSelection(): {
    getSelectedText(): string;
  } | null;
}

export function readSelectedText(
  reader: StepCliTuiSelectionReader,
): string | null {
  const selection = reader.getSelection();
  if (!selection) {
    return null;
  }

  const text = selection.getSelectedText();
  return text.length > 0 ? text : null;
}
