export type BrandMarkVariant = "full" | "compact";

const FULL_BRAND_MARK_ROWS = [
  "                  ####",
  "  #   #############   ",
  "  #  ##############   ",
  "  #  ##############   ",
  "  #  #####            ",
  "  #  #####            ",
  "     #####  ##########",
  "     #####  ####      ",
  "##########  ####      ",
  "##########  ####      ",
  "            ####      ",
  "            ####      ",
] as const;

const COMPACT_BRAND_MARK_ROWS = [
  "                   ###",
  "  #  ##############   ",
  "  #  ##############   ",
  "  #  ##############   ",
  "  #  #####            ",
  "     #####  ##########",
  "##########  ####      ",
  "##########  ####      ",
  "##########  ####      ",
  "            ####      ",
] as const;

export function getBrandMarkRows(
  variant: BrandMarkVariant = "full",
): readonly string[] {
  return variant === "compact" ? COMPACT_BRAND_MARK_ROWS : FULL_BRAND_MARK_ROWS;
}
