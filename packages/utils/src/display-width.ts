import stringWidth from "string-width";

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      })
    : null;

export function visibleLength(value: string): number {
  return stringWidth(value);
}

export function truncateInlineText(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (visibleLength(value) <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return Array.from(iterateGraphemes(value)).slice(0, maxChars).join("");
  }

  const availableWidth = maxChars - visibleLength("…");
  let truncated = "";

  for (const grapheme of iterateGraphemes(value)) {
    if (visibleLength(truncated + grapheme) > availableWidth) {
      break;
    }
    truncated += grapheme;
  }

  return `${truncated}…`;
}

function* iterateGraphemes(value: string): Iterable<string> {
  if (graphemeSegmenter) {
    for (const segment of graphemeSegmenter.segment(value)) {
      yield segment.segment;
    }
    return;
  }

  yield* value;
}
