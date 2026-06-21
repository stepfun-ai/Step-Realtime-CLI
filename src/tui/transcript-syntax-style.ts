import { RGBA, SyntaxStyle } from "@opentui/core";
import type { StepCliTuiThemeColors } from "./theme.js";

export function buildSyntaxStyleFromTheme(
  theme: StepCliTuiThemeColors,
): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    keyword: { fg: RGBA.fromHex(theme.brand), bold: true },
    string: { fg: RGBA.fromHex(theme.success) },
    comment: { fg: RGBA.fromHex(theme.muted), italic: true },
    number: { fg: RGBA.fromHex(theme.warning) },
    function: { fg: RGBA.fromHex(theme.accent) },
    type: { fg: RGBA.fromHex(theme.brand) },
    variable: { fg: RGBA.fromHex(theme.foreground) },
    operator: { fg: RGBA.fromHex(theme.muted) },
    punctuation: { fg: RGBA.fromHex(theme.muted) },
    default: { fg: RGBA.fromHex(theme.foreground) },
  });
}
