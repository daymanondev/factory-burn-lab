/**
 * Burn Lab client theme kit — React Native inline styles + theme colours.
 * Function factories only: zero class syntax for Hermes compatibility.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import type { PressableStateCallbackType, TextStyle } from "react-native";

export const SPACING = {
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  2.5: 10,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
} as const;

const FONT_SIZE = {
  xs: 11,
  code: 12,
  sm: 12,
  section: 13,
  base: 14,
  lg: 16,
} as const;

export const RADIUS = { sm: 4, md: 6, lg: 8, xl: 10 } as const;

export const DOT = 8;

export const CONTROL_H = 32;
export const CONTROL_SM = 26;
export const PILL_H = 22;

export type Colour = keyof PluginTheme["colors"];

const ROLES = {
  badge: { fontSize: FONT_SIZE.xs, lineHeight: 14, fontWeight: "600", colour: "foregroundMuted" },
  label: { fontSize: FONT_SIZE.sm, lineHeight: 16, fontWeight: "500", colour: "foregroundMuted" },
  rowTitle: { fontSize: FONT_SIZE.base, lineHeight: 18, fontWeight: "600", colour: "foreground" },
  section: { fontSize: FONT_SIZE.section, lineHeight: 18, fontWeight: "600", colour: "foreground" },
  stat: { fontSize: 20, lineHeight: 24, fontWeight: "600", colour: "foreground" },
  detailTitle: { fontSize: FONT_SIZE.lg, lineHeight: 22, fontWeight: "600", colour: "foreground" },
  meta: { fontSize: FONT_SIZE.sm, lineHeight: 18, fontWeight: "400", colour: "foregroundMuted" },
  code: {
    fontSize: FONT_SIZE.code,
    lineHeight: 16,
    fontWeight: "500",
    colour: "foreground",
    fontFamily: "monospace",
  },
} as const satisfies Record<string, TextStyle & { colour: Colour }>;

export type Role = keyof typeof ROLES;

export function text(theme: PluginTheme, role: Role, colour?: Colour): TextStyle {
  const { colour: base, ...style } = ROLES[role];
  return { ...style, color: theme.colors[colour ?? base] };
}

export function tint(colour: string, alpha = "22"): string {
  if (!/^#[0-9a-f]{6}$/i.test(colour)) return colour;
  return `${colour}${alpha}`;
}

export function hoveredOf(state: PressableStateCallbackType): boolean {
  return "hovered" in state && (state as { hovered?: boolean }).hovered === true;
}
