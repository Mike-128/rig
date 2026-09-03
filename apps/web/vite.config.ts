import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const runtime = process.env.RIG_URL ?? "http://127.0.0.1:7777";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: runtime, changeOrigin: true },
    },
  },
});
