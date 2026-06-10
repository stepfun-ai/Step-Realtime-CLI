import type readline from "node:readline";
import {
  browseCliHistory,
  detachCliHistory,
  rememberSubmittedCliHistoryValue,
  type StepCliCliHistoryState,
} from "./history-state.js";

export interface StepCliReadlineHistoryTarget {
  line: string;
  cursor: number;
  _ttyWrite: (data: string, key: readline.Key) => void;
  _deleteLineLeft: () => void;
  _insertString: (value: string) => void;
}

export interface StepCliReadlineHistoryBinding {
  rememberSubmittedValue: (value: string) => void;
  dispose: () => void;
}

export function bindCliHistoryToReadline(
  target: StepCliReadlineHistoryTarget,
): StepCliReadlineHistoryBinding {
  let promptHistory: StepCliCliHistoryState = {
    entries: [],
    browsingIndex: null,
    draftBeforeBrowsing: null,
  };
  const originalTtyWrite = target._ttyWrite.bind(target);

  target._ttyWrite = (data: string, key: readline.Key) => {
    if (isHistoryArrowKey(key)) {
      const nextState = browseCliHistory(
        promptHistory,
        target.line,
        key.name === "up" ? "older" : "newer",
      );
      promptHistory = nextState.history;
      replaceReadlineLine(target, nextState.value);
      return;
    }

    if (
      promptHistory.browsingIndex !== null &&
      shouldDetachCliHistoryOnKeypress(data, key)
    ) {
      promptHistory = detachCliHistory(promptHistory);
    }

    originalTtyWrite(data, key);
  };

  return {
    rememberSubmittedValue(value: string) {
      promptHistory = rememberSubmittedCliHistoryValue(promptHistory, value);
    },
    dispose() {
      target._ttyWrite = originalTtyWrite;
    },
  };
}

function replaceReadlineLine(
  target: Pick<
    StepCliReadlineHistoryTarget,
    "line" | "cursor" | "_deleteLineLeft" | "_insertString"
  >,
  value: string,
): void {
  target.cursor = target.line.length;
  target._deleteLineLeft();
  if (value.length > 0) {
    target._insertString(value);
  }
}

function isHistoryArrowKey(key: readline.Key | undefined): boolean {
  return Boolean(
    key &&
    !key.ctrl &&
    !key.meta &&
    !key.shift &&
    (key.name === "up" || key.name === "down"),
  );
}

function shouldDetachCliHistoryOnKeypress(
  data: string,
  key: readline.Key | undefined,
): boolean {
  if (!key) {
    return data.length > 0;
  }

  if (key.name === "backspace" || key.name === "delete") {
    return true;
  }

  if (key.ctrl && (key.name === "u" || key.name === "k" || key.name === "w")) {
    return true;
  }

  if (
    key.name === "up" ||
    key.name === "down" ||
    key.name === "left" ||
    key.name === "right" ||
    key.name === "home" ||
    key.name === "end" ||
    key.name === "escape" ||
    key.name === "return" ||
    key.name === "enter" ||
    key.name === "tab"
  ) {
    return false;
  }

  return !key.ctrl && !key.meta && data.length > 0;
}
