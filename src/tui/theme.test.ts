import { describe, expect, it } from "vitest";
import { getBuiltinTuiThemes } from "./theme.js";

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.trim().replace(/^#/, "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((character) => `${character}${character}`)
          .join("")
      : normalized.slice(0, 6);

  return [
    Number.parseInt(expanded.slice(0, 2), 16) / 255,
    Number.parseInt(expanded.slice(2, 4), 16) / 255,
    Number.parseInt(expanded.slice(4, 6), 16) / 255,
  ];
}

function linearize(channel: number): number {
  return channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = hexToRgb(hex).map(linearize);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(left: string, right: string): number {
  const [lighter, darker] = [
    relativeLuminance(left),
    relativeLuminance(right),
  ].sort((first, second) => second - first);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("builtin TUI themes", () => {
  const themes = getBuiltinTuiThemes();

  it("keeps foreground and muted text readable on core surfaces", () => {
    for (const theme of themes) {
      expect(
        contrastRatio(theme.colors.foreground, theme.colors.canvas),
        `${theme.name} foreground vs canvas`,
      ).toBeGreaterThanOrEqual(7);
      expect(
        contrastRatio(theme.colors.foreground, theme.colors.panel),
        `${theme.name} foreground vs panel`,
      ).toBeGreaterThanOrEqual(7);
      expect(
        contrastRatio(theme.colors.foreground, theme.colors.inputBackground),
        `${theme.name} foreground vs inputBackground`,
      ).toBeGreaterThanOrEqual(7);
      expect(
        contrastRatio(theme.colors.muted, theme.colors.canvas),
        `${theme.name} muted vs canvas`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.colors.muted, theme.colors.panel),
        `${theme.name} muted vs panel`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.colors.foreground, theme.colors.selection),
        `${theme.name} foreground vs selection`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps rails and badges visible against panel surfaces", () => {
    for (const theme of themes) {
      expect(
        contrastRatio(theme.colors.line, theme.colors.panel),
        `${theme.name} line vs panel`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(theme.colors.line, theme.colors.panelAlt),
        `${theme.name} line vs panelAlt`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(theme.colors.line, theme.colors.inputBackground),
        `${theme.name} line vs inputBackground`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(theme.colors.foreground, theme.colors.assistantBadge),
        `${theme.name} badge foreground vs assistantBadge`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.colors.foreground, theme.colors.userBadge),
        `${theme.name} badge foreground vs userBadge`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.colors.foreground, theme.colors.toolBadge),
        `${theme.name} badge foreground vs toolBadge`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.colors.foreground, theme.colors.systemBadge),
        `${theme.name} badge foreground vs systemBadge`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
