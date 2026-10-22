import { defineConfig } from "vite";

export default defineConfig({
  plugins: [],
  server: { host: true, port: 5173 },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
    outDir: "dist",
    copyPublicDir: true,
  },
});
