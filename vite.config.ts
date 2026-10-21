import { defineConfig, loadEnv } from "vite";

// Tauri（`tauri dev` / `tauri build`）からも、ブラウザ単体からも使える設定。
// https://v2.tauri.app/start/frontend/vite/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", ["TAURI_"]);
  const host = env["TAURI_DEV_HOST"];
  const platform = env["TAURI_ENV_PLATFORM"];
  return {
    // Tauri CLI のログを消さない
    clearScreen: false,
    envPrefix: ["VITE_", "TAURI_ENV_"],
    server: {
      // tauri.conf.json の devUrl と一致させるため固定
      port: 5173,
      strictPort: true,
      host: host ?? false,
      ...(host === undefined ? {} : { hmr: { protocol: "ws", host, port: 5174 } }),
      watch: { ignored: ["**/src-tauri/**"] },
    },
    build: {
      // Tauri の WebView（Windows: WebView2 / macOS・Linux: WebKit）に合わせる
      target: platform === undefined ? "es2022" : platform === "windows" ? "chrome105" : "safari15",
      // Phaser 本体だけで 1.5MB 近くあるため
      chunkSizeWarningLimit: 2000,
    },
  };
});
