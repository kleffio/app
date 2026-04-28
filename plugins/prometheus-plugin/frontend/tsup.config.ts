import { defineConfig } from "tsup";
import path from "path";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["iife"],
  globalName: "KleffPlugin",
  outDir: "dist",
  clean: true,
  minify: true,
  outExtension: () => ({ js: ".js" }),
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  esbuildOptions(options) {
    options.alias = {
      react: path.resolve("./src/shims/react.ts"),
      "react/jsx-runtime": path.resolve("./src/shims/react-jsx-runtime.ts"),
      "react-dom": path.resolve("./src/shims/react-dom.ts"),
      "@kleffio/sdk": path.resolve("./src/shims/sdk.ts"),
    };
  },
});
