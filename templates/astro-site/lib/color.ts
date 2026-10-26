function channel(hex: string, index: number) {
  const value = Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
export function luminance(hex: string) {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
}
export function contrastRatio(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
export function textColorOn(background: string) {
  const light = "#ffffff",
    dark = "#1a1a1a";
  const chosen = contrastRatio(background, light) >= contrastRatio(background, dark) ? light : dark;
  return contrastRatio(background, chosen) >= 4.5 ? chosen : "#000000";
}
