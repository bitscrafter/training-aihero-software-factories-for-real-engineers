import { defineConfig, configDefaults } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    // Agent worktrees live under .claude/worktrees; their tests aren't ours.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
