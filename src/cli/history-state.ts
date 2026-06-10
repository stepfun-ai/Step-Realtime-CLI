export interface StepCliCliHistoryState {
  entries: string[];
  browsingIndex: number | null;
  draftBeforeBrowsing: string | null;
}

export type StepCliCliHistoryDirection = "older" | "newer";

export function shouldRememberCliHistoryValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && !trimmed.startsWith("/");
}

export function rememberSubmittedCliHistoryValue(
  history: StepCliCliHistoryState,
  value: string,
): StepCliCliHistoryState {
  if (!shouldRememberCliHistoryValue(value)) {
    return detachCliHistory(history);
  }

  return {
    entries: [...history.entries, value],
    browsingIndex: null,
    draftBeforeBrowsing: null,
  };
}

export function browseCliHistory(
  history: StepCliCliHistoryState,
  currentValue: string,
  direction: StepCliCliHistoryDirection,
): {
  history: StepCliCliHistoryState;
  value: string;
} {
  if (history.entries.length === 0) {
    return { history, value: currentValue };
  }

  if (direction === "older") {
    const nextIndex =
      history.browsingIndex === null
        ? history.entries.length - 1
        : Math.max(0, history.browsingIndex - 1);
    const nextValue = history.entries[nextIndex] ?? "";

    return {
      history: {
        entries: history.entries,
        browsingIndex: nextIndex,
        draftBeforeBrowsing: history.draftBeforeBrowsing ?? currentValue,
      },
      value: nextValue,
    };
  }

  if (history.browsingIndex === null) {
    return { history, value: currentValue };
  }

  const nextIndex = history.browsingIndex + 1;
  if (nextIndex < history.entries.length) {
    const nextValue = history.entries[nextIndex] ?? "";
    return {
      history: {
        ...history,
        browsingIndex: nextIndex,
      },
      value: nextValue,
    };
  }

  return {
    history: {
      entries: history.entries,
      browsingIndex: null,
      draftBeforeBrowsing: null,
    },
    value: history.draftBeforeBrowsing ?? "",
  };
}

export function detachCliHistory(
  history: StepCliCliHistoryState,
): StepCliCliHistoryState {
  if (history.browsingIndex === null && history.draftBeforeBrowsing === null) {
    return history;
  }

  return {
    entries: history.entries,
    browsingIndex: null,
    draftBeforeBrowsing: null,
  };
}
