import { defineConfig } from "vite";

export default defineConfig({
  server: { host: true, port: 5173 },
  // Phaser 本体だけで 1.5MB 近くあるため
  build: { chunkSizeWarningLimit: 2000 },
});
