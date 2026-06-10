export interface WeightedSearchField {
  text?: string;
  weight: number;
}

export function scoreFuzzyMatch(
  query: string,
  fields: WeightedSearchField[],
): number {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) {
    return 0;
  }

  const tokens = tokenizeSearchText(query);
  const denseQuery = stripSeparators(normalizedQuery);
  let score = 0;

  for (const field of fields) {
    const rawText = field.text?.trim();
    if (!rawText) {
      continue;
    }

    const normalizedField = normalizeSearchText(rawText);
    if (normalizedField.length === 0) {
      continue;
    }

    if (normalizedField === normalizedQuery) {
      score += 120 * field.weight;
      continue;
    }

    if (normalizedField.startsWith(normalizedQuery)) {
      score += 90 * field.weight;
    } else if (normalizedField.includes(normalizedQuery)) {
      score += 60 * field.weight;
    }

    let matchedTokens = 0;
    for (const token of tokens) {
      if (normalizedField.includes(token)) {
        matchedTokens += 1;
      }
    }

    if (matchedTokens > 0) {
      score += matchedTokens * 16 * field.weight;
      if (matchedTokens === tokens.length) {
        score += 12 * field.weight;
      }
    }

    if (
      denseQuery.length > 2 &&
      isSubsequence(denseQuery, stripSeparators(normalizedField))
    ) {
      score += 10 * field.weight;
    }
  }

  return score;
}

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function tokenizeSearchText(value: string): string[] {
  const normalized = normalizeSearchText(value);
  if (normalized.length === 0) {
    return [];
  }

  const unique = new Set<string>();
  for (const token of normalized.split(/[^a-z0-9:_-]+/)) {
    const trimmed = token.trim();
    if (trimmed.length > 0) {
      unique.add(trimmed);
    }
  }

  if (unique.size === 0) {
    unique.add(normalized);
  }

  return [...unique];
}

function stripSeparators(value: string): string {
  return value.replace(/[^a-z0-9]+/g, "");
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (
    needle.length === 0 ||
    haystack.length === 0 ||
    needle.length > haystack.length
  ) {
    return false;
  }

  let haystackIndex = 0;
  for (let needleIndex = 0; needleIndex < needle.length; needleIndex += 1) {
    const char = needle[needleIndex];
    while (
      haystackIndex < haystack.length &&
      haystack[haystackIndex] !== char
    ) {
      haystackIndex += 1;
    }
    if (haystackIndex >= haystack.length) {
      return false;
    }
    haystackIndex += 1;
  }

  return true;
}
