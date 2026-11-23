/**
 * Font choices for the launcher UI. Every stack starts with a family Windows
 * ships, so a pick is visible even without any extra download.
 */

import type { FontId } from "./types";

interface FontChoice {
  id: FontId;
  label: string;
  /** CSS stack for the UI text. */
  stack: string;
  /** CSS stack for headings; empty = same as the UI text. */
  display?: string;
}

export const FONTS: FontChoice[] = [
  {
    id: "standard",
    label: "Standard",
    stack: '"Segoe UI Variable Text", "Segoe UI", Inter, system-ui, -apple-system, sans-serif',
    display:
      '"Segoe UI Variable Display", "Segoe UI", Inter, system-ui, -apple-system, sans-serif',
  },
  {
    id: "bahnschrift",
    label: "Technisch",
    stack: 'Bahnschrift, "Segoe UI", system-ui, sans-serif',
  },
  {
    id: "georgia",
    label: "Serif",
    stack: 'Georgia, "Times New Roman", serif',
  },
  {
    id: "mono",
    label: "Mono",
    stack: '"Cascadia Mono", Consolas, ui-monospace, monospace',
  },
  {
    id: "pixel",
    label: "Pixel",
    stack: '"Minecraft", "Cascadia Mono", Consolas, ui-monospace, monospace',
  },
];

export function resolveFont(id: string | undefined): FontChoice {
  return FONTS.find((font) => font.id === id) ?? FONTS[0];
}
