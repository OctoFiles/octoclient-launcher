function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const value =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => char + char)
          .join("")
      : clean.padEnd(6, "0").slice(0, 6);
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

export function mixHex(from: string, to: string, t: number): string {
  const [r1, g1, b1] = parseHex(from);
  const [r2, g2, b2] = parseHex(to);
  const ratio = Math.max(0, Math.min(1, t));
  return `rgb(${clamp(r1 + (r2 - r1) * ratio)}, ${clamp(g1 + (g2 - g1) * ratio)}, ${clamp(
    b1 + (b2 - b1) * ratio,
  )})`;
}

/** amount > 0 lightens, amount < 0 darkens. */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = parseHex(hex);
  const target = amount >= 0 ? 255 : 0;
  const ratio = Math.abs(amount);
  return `rgb(${clamp(r + (target - r) * ratio)}, ${clamp(g + (target - g) * ratio)}, ${clamp(
    b + (target - b) * ratio,
  )})`;
}
