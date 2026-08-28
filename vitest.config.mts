import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const rootDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(rootDirectory, "src"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "./coverage",
      include: [
        "src/lib/{accounts,auth,cleanup,config,db,sessions,audio,r2,voters}.ts",
        "src/app/api/**/*.ts",
        "src/components/Dashboard.tsx",
      ],
      exclude: ["src/app/api/**/*.d.ts"],
      thresholds: {
        statements: 65,
        branches: 55,
        functions: 60,
        lines: 65,
      },
    },
  },
});
