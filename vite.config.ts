import { defineConfig } from "vite";

// ブラウザアプリとしてビルドする。Cloudflare Pages では
// ビルドコマンド `npm run build`、出力ディレクトリ `dist` を指定する。
export default defineConfig({
  server: { host: true, port: 5173 },
  build: {
    target: "es2022",
    // Phaser 本体だけで 1.5MB 近くあるため
    chunkSizeWarningLimit: 2000,
  },
});
