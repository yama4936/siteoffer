const graphemes = new Intl.Segmenter("ja", { granularity: "grapheme" });
type Measure = (text: string) => number;

/** Keep graphemes intact and preserve explicit line breaks. All text remains in the output. */
export function wrapPdfText(text: string, measure: Measure, width: number): string[] {
  if (!Number.isFinite(width) || width <= 0) throw new RangeError("PDFの文字幅を確認してください");
  const lines: string[] = [];
  const widths = new Map<string, number>();
  const cleaned = Array.from(text.replace(/\r\n?/g, "\n").replace(/\t/g, "  "))
    .filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
    .join("");
  for (const paragraph of cleaned.split("\n")) {
    let line = "",
      length = 0;
    for (const { segment } of graphemes.segment(paragraph)) {
      let size = widths.get(segment);
      if (size === undefined) {
        size = measure(segment);
        if (!Number.isFinite(size) || size < 0 || size > width) throw new RangeError("PDFの文字を配置できません");
        widths.set(segment, size);
      }
      if (line && length + size > width) {
        lines.push(line);
        line = "";
        length = 0;
      }
      line += segment;
      length += size;
    }
    lines.push(line);
  }
  return lines;
}

/** Repeated page headers may abbreviate a name; the cover always prints its full value. */
export function compactPdfHeader(text: string, measure: Measure, width: number, maxLines = 2): string[] {
  if (!Number.isSafeInteger(maxLines) || maxLines < 1) throw new RangeError("PDFの見出し行数を確認してください");
  const lines = wrapPdfText(text.replace(/\s+/g, " ").trim(), measure, width);
  if (lines.length <= maxLines) return lines;
  const output = lines.slice(0, maxLines);
  const last = Array.from(graphemes.segment(output[maxLines - 1]!), (part) => part.segment);
  while (last.length && measure(`${last.join("")}...`) > width) last.pop();
  if (measure(`${last.join("")}...`) > width) throw new RangeError("PDFの見出しを配置できません");
  output[maxLines - 1] = `${last.join("")}...`;
  return output;
}
