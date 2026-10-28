/** 住所の先頭から都道府県と市区町村を取る。取れなければnull（推測で埋めない） */
export function splitAddress(address: string | null): { prefecture: string | null; city: string | null } {
  if (!address) return { prefecture: null, city: null };
  const normalized = address.replace(/^〒?\s*\d{3}-?\d{4}\s*/, "");
  const m = normalized.match(/^(東京都|北海道|京都府|大阪府|.{2,3}?県)(.+?郡.+?[町村]|.+?市|.+?区|.+?[町村])?/);
  let city = m?.[2] ?? null;
  // 四日市市・廿日市市・野々市市のように、自治体名そのものに「市」を含む場合も
  // 最初の「市」で切らず、直後の自治体接尾辞まで含める。
  if (city?.endsWith("市") && normalized.slice((m?.[1]?.length ?? 0) + city.length).startsWith("市")) city += "市";
  return { prefecture: m?.[1] ?? null, city };
}
