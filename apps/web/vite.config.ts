import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { target: "es2022" },
  server: {
    proxy: {
      "/api": {
        // The development proxy is local-only. Make its upstream request
        // same-origin with the API so the API's state-changing request guard
        // remains effective without rejecting proxied browser requests.
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        headers: { origin: "http://127.0.0.1:8080" },
      },
    },
  },
});
