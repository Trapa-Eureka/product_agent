// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Infrastructure packages that must never be imported by framework-independent
 * layers. Enforces CLAUDE.md rules 2-3 and ARCHITECTURE.md §6 mechanically
 * instead of by prose (WORKFLOW.md §9).
 */
const INFRASTRUCTURE_PACKAGES = [
  "express",
  "mongodb",
  "mongoose",
  "ws",
  "@angular/core",
  "@modelcontextprotocol/sdk",
];

const INFRASTRUCTURE_PATTERNS = ["@aws-sdk/*", "@smithy/*", "@angular/*"];

const boundaryRule = (layer) => {
  const message = `${layer} must stay framework-independent. Depend on a port instead (ARCHITECTURE.md §6).`;
  return {
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: INFRASTRUCTURE_PACKAGES.map((name) => ({ name, message })),
          patterns: INFRASTRUCTURE_PATTERNS.map((group) => ({ group: [group], message })),
        },
      ],
    },
  };
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "off",
      eqeqeq: ["error", "always"],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["packages/domain/**/*.ts"],
    ...boundaryRule("packages/domain"),
  },
  {
    files: ["packages/application/**/*.ts"],
    ...boundaryRule("packages/application"),
  },
  {
    files: ["**/*.test.ts", "tests/**/*.ts", "scripts/**/*.mjs"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
);
