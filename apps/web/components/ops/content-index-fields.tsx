import { type ContentIndexQuery, contentIndexParams } from "@/lib/content-index-query";
export function ContentIndexFields({ query, omit = [] }: { query: ContentIndexQuery; omit?: string[] }) {
  return Array.from(contentIndexParams(query))
    .filter(([name]) => !omit.includes(name))
    .map(([name, value]) => <input type="hidden" name={name} value={value} key={name} />);
}
