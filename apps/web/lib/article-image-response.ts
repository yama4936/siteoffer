export function articleImageResponse(file: { bytes: Buffer } | null, privateImage = false) {
  const headers = {
    "Cache-Control": privateImage ? "private, no-store" : "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(privateImage ? { Vary: "Cookie", "X-Robots-Tag": "noindex" } : {}),
  };
  if (!file) return new Response("Not Found", { status: 404, headers });
  return new Response(new Uint8Array(file.bytes), {
    headers: { ...headers, "Content-Type": "image/png", "Content-Disposition": 'inline; filename="article-photo.png"' },
  });
}
