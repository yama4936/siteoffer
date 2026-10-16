import sharp from "sharp";

export async function normalizeDesignImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > 12 * 1024 * 1024)
    throw new Error("画像は12MB以下のPNG・JPEG・WebPを指定してください");
  const source = sharp(bytes, { limitInputPixels: 20_000_000, failOn: "warning" });
  const meta = await source.metadata();
  if (!["png", "jpeg", "webp"].includes(meta.format ?? "") || (meta.pages ?? 1) !== 1)
    throw new Error("静止画のPNG・JPEG・WebPだけを使用できます");
  if (!meta.width || !meta.height || meta.width < 640 || meta.height < 480)
    throw new Error("640×480以上のデザイン画像を使用してください");
  const { data, info } = await source
    .rotate()
    .resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  if (data.length > 12 * 1024 * 1024) throw new Error("変換後の画像が12MBを超えました");
  return { png: data, width: info.width, height: info.height };
}

export interface ImageGenerator {
  generate(
    prompt: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    bytes: Buffer;
    requestId: string | null;
    usage: unknown;
  }>;
}
/** No automatic retries: an ambiguous timeout could already have been billed. */
export function createOpenAIImageGenerator(apiKey: string, transport: typeof fetch = fetch): ImageGenerator {
  if (!apiKey) throw new Error("画像生成用APIキーが未設定です");
  return {
    async generate(prompt, model, signal) {
      const timeout = AbortSignal.timeout(300_000);
      const res = await transport("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, n: 1, size: "1536x1024", quality: "high", output_format: "png" }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`画像APIがHTTP ${res.status}を返しました。認証・モデルの利用可否・利用上限を確認してください`);
      }
      // Bound response before parsing. Never persist provider error bodies or request headers.
      const reader = res.body?.getReader();
      if (!reader) throw new Error("画像APIの応答が空です");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 20 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("画像APIの応答サイズが上限を超えました");
        }
        chunks.push(chunk.value);
      }
      const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        data?: { b64_json?: string }[];
        usage?: unknown;
      };
      const encoded = json.data?.[0]?.b64_json;
      if (!encoded || !/^[A-Za-z0-9+/=\s]+$/.test(encoded)) throw new Error("画像APIから画像を取得できませんでした");
      return {
        bytes: Buffer.from(encoded, "base64"),
        requestId: res.headers.get("x-request-id"),
        usage: json.usage ?? null,
      };
    },
  };
}
