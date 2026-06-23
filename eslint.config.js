import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  // Ignore generated and external dirs
  {
    ignores: ["dist/**", "node_modules/**", "temp/**"],
  },

  // Base JS recommended rules
  eslint.configs.recommended,

  // TypeScript-eslint recommended rules (type-checked for full power)
  ...tseslint.configs.recommendedTypeChecked,

  // Prettier must be last — disables ESLint rules that conflict with formatting
  prettierConfig,

  // Project-wide language options
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // MCP SDK tool callbacks are typed as async even when synchronous — suppress the noise
      "@typescript-eslint/require-await": "off",
      // JSON file reads produce `any` — downgrade to warning rather than error
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      // Allow explicit `any` where necessary (MCP SDK types can be loose)
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow unused vars prefixed with _ (convention for intentionally unused)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Enforce consistent type imports
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // Disable the base rule in favour of TS-aware version
      "no-unused-vars": "off",
    },
  }
);
