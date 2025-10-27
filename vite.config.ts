import { defineConfig } from "vite";
import { resolve } from "path";
import inject from "@rollup/plugin-inject";

export default defineConfig({
  resolve: {
    alias: {
      buffer: "buffer",
    },
  },
  plugins: [
    inject({
      Buffer: ["buffer", "Buffer"],
    }),
  ],
});
