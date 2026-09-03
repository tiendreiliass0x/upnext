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
    // Claude Code worktrees live under .claude/; without this a checked-out
    // worktree doubles every test file.
    exclude: ["**/node_modules/**", "**/.claude/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "./coverage",
      include: [
        "src/lib/{accounts,admin,auth,cleanup,config,connections,db,images,libraries,playlists,profile,provider-preview,secrets,sessions,audio,r2,voters}.ts",
        "src/lib/providers/*.ts",
        "src/app/api/**/*.ts",
        "src/components/Dashboard.tsx",
        "src/components/PlayConsole.tsx",
        "src/components/SourcePicker.tsx",
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
