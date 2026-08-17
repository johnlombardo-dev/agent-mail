import { defineConfig } from "vite-plus";

const frozenAndGenerated = [
  "**/node_modules/**",
  "**/dist/**",
  "**/*.test.ts",
  "**/*.compile.ts",
  "**/test/**",
  "PLAN.md",
  "docs/planning/EVIDENCE.md",
  ".agents/skills/plan-agent-mail/references/**",
];

export default defineConfig({
  lint: {
    ignorePatterns: frozenAndGenerated,
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: frozenAndGenerated,
  },
});
