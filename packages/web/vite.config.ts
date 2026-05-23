import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwind()],
  build: {
    lib: {
      entry: resolve(__dirname, "src/ui.ts"),
      formats: ["es"],
      fileName: () => "index.mjs",
    },
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      external: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react-router-dom",
        "@tanstack/react-query",
        "@boringos/ui",
      ],
      output: {
        entryFileNames: "index.mjs",
        assetFileNames: (info) => {
          const name = info.name ?? "";
          if (name === "style.css" || name.endsWith(".css")) return "index.css";
          return "assets/[name]-[hash][extname]";
        },
        chunkFileNames: "assets/[name]-[hash].js",
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      // BoringOS dev server defaults to 3030 (not 3000). Override via
      // EA_API_TARGET env if your host runs elsewhere.
      "/api": process.env.EA_API_TARGET ?? "http://localhost:3030",
    },
  },
});
