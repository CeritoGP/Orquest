import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard",
          environment: "jsdom",
          include: ["apps/dashboard/src/**/*.test.tsx"],
        },
      },
    ],
  },
});

