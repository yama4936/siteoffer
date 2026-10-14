// 静的サイトとしてビルドする（24.5）。出力先・public・キャッシュはビルド関数（build/build-site.ts）が環境変数で渡す。
import { defineConfig } from "astro/config";

const env = process.env;

export default defineConfig({
  output: "static",
  // ビルドごとに別の一時ディレクトリ（入力の画像をコピーしたもの）を public として使う
  ...(env.SITEOFFER_PUBLIC_DIR ? { publicDir: env.SITEOFFER_PUBLIC_DIR } : {}),
  ...(env.SITEOFFER_CACHE_DIR ? { cacheDir: env.SITEOFFER_CACHE_DIR } : {}),
  build: {
    format: "directory",
    // 1ページなのでCSSはHTMLへ埋め込む（外部・別ファイルへの依存を減らす）
    inlineStylesheets: "always",
  },
  devToolbar: { enabled: false },
  vite: {
    ...(env.SITEOFFER_CACHE_DIR ? { cacheDir: `${env.SITEOFFER_CACHE_DIR}/vite` } : {}),
  },
});
