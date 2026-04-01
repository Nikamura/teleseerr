import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "web/", "data/"],
  },

  eslint.configs.recommended,

  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    rules: {
      "@typescript-eslint/no-non-null-assertion": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Allow numbers and booleans in template literals (idiomatic in URL building)
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      // The `return json(res, data)` early-return pattern is used pervasively in routing
      "@typescript-eslint/no-confusing-void-expression": "off",
      // This codebase uses `type` consistently, not `interface`
      "@typescript-eslint/consistent-type-definitions": "off",
      // Allow async functions in event handlers (process.on, .catch callbacks)
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false } },
      ],
    },
  },

  eslintConfigPrettier,
);
