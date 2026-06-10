export interface SlashPaletteWindow<T> {
  items: readonly T[];
  startIndex: number;
  endIndex: number;
  hasOverflowAbove: boolean;
  hasOverflowBelow: boolean;
}

export function resolveSlashPaletteWindow<T>(
  items: readonly T[],
  selectedIndex: number,
  maxItems: number,
): SlashPaletteWindow<T> {
  const safeMaxItems = Math.max(1, Math.trunc(maxItems) || 1);
  if (items.length === 0) {
    return {
      items: [],
      startIndex: 0,
      endIndex: 0,
      hasOverflowAbove: false,
      hasOverflowBelow: false,
    };
  }

  const clampedSelectedIndex = Math.max(
    0,
    Math.min(selectedIndex, items.length - 1),
  );
  const maxStartIndex = Math.max(0, items.length - safeMaxItems);
  const startIndex = Math.max(
    0,
    Math.min(clampedSelectedIndex - safeMaxItems + 1, maxStartIndex),
  );
  const visibleItems = items.slice(startIndex, startIndex + safeMaxItems);
  const endIndex = startIndex + visibleItems.length;

  return {
    items: visibleItems,
    startIndex,
    endIndex,
    hasOverflowAbove: startIndex > 0,
    hasOverflowBelow: endIndex < items.length,
  };
}
