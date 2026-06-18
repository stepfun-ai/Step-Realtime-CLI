import type {
  StepCliTuiComposerHistoryState,
  StepCliTuiComposerState,
} from "./types.js";

export type StepCliTuiComposerHistoryDirection = "older" | "newer";

const MAX_COMPOSER_HISTORY_ENTRIES = 200;

export function applyComposerPaste(
  composer: StepCliTuiComposerState,
  text: string,
): StepCliTuiComposerState {
  const normalizedText = normalizeComposerPasteText(text);
  if (normalizedText.length === 0) {
    return composer;
  }

  const nextValue =
    composer.value.slice(0, composer.cursorIndex) +
    normalizedText +
    composer.value.slice(composer.cursorIndex);

  return {
    value: nextValue,
    cursorIndex: composer.cursorIndex + normalizedText.length,
  };
}

export function rememberSubmittedComposerValue(
  history: StepCliTuiComposerHistoryState,
  composer: StepCliTuiComposerState,
): StepCliTuiComposerHistoryState {
  const trimmed = composer.value.trim();
  if (trimmed.length === 0 || trimmed.startsWith("/")) {
    return detachComposerHistory(history);
  }

  const lastEntry = history.entries[history.entries.length - 1];
  if (lastEntry?.value === composer.value) {
    return detachComposerHistory(history);
  }

  return {
    entries: [...history.entries, cloneComposerState(composer)].slice(
      -MAX_COMPOSER_HISTORY_ENTRIES,
    ),
    browsingIndex: null,
    draftBeforeBrowsing: null,
  };
}

export function browseComposerHistory(
  history: StepCliTuiComposerHistoryState,
  composer: StepCliTuiComposerState,
  direction: StepCliTuiComposerHistoryDirection,
): {
  history: StepCliTuiComposerHistoryState;
  composer: StepCliTuiComposerState;
} {
  if (history.entries.length === 0) {
    return { history, composer };
  }

  if (direction === "older") {
    if (history.browsingIndex === 0) {
      return { history, composer };
    }

    const nextIndex =
      history.browsingIndex === null
        ? history.entries.length - 1
        : Math.max(0, history.browsingIndex - 1);
    const nextComposer = history.entries[nextIndex];
    if (!nextComposer) {
      return { history, composer };
    }

    return {
      history: {
        entries: history.entries,
        browsingIndex: nextIndex,
        draftBeforeBrowsing:
          history.draftBeforeBrowsing ?? cloneComposerState(composer),
      },
      composer: cloneComposerState(nextComposer),
    };
  }

  if (history.browsingIndex === null) {
    return { history, composer };
  }

  const nextIndex = history.browsingIndex + 1;
  if (nextIndex < history.entries.length) {
    const nextComposer = history.entries[nextIndex];
    if (!nextComposer) {
      return { history, composer };
    }

    return {
      history: {
        ...history,
        browsingIndex: nextIndex,
      },
      composer: cloneComposerState(nextComposer),
    };
  }

  return {
    history: {
      entries: history.entries,
      browsingIndex: null,
      draftBeforeBrowsing: null,
    },
    composer: history.draftBeforeBrowsing ?? {
      value: "",
      cursorIndex: 0,
    },
  };
}

export function detachComposerHistory(
  history: StepCliTuiComposerHistoryState,
): StepCliTuiComposerHistoryState {
  if (history.browsingIndex === null && history.draftBeforeBrowsing === null) {
    return history;
  }

  return {
    entries: history.entries,
    browsingIndex: null,
    draftBeforeBrowsing: null,
  };
}

export function normalizeComposerPasteText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function cloneComposerState(
  composer: StepCliTuiComposerState,
): StepCliTuiComposerState {
  return {
    value: composer.value,
    cursorIndex: composer.cursorIndex,
  };
}
