const tsParserImport = require("@typescript-eslint/parser");
const tsPluginImport = require("@typescript-eslint/eslint-plugin");
const reactRefreshImport = require("eslint-plugin-react-refresh");
const reactHooksImport = require("eslint-plugin-react-hooks");

const tsParser = tsParserImport.default ?? tsParserImport;
const tsPlugin = tsPluginImport.default ?? tsPluginImport;
const reactRefresh = reactRefreshImport.default ?? reactRefreshImport;
const reactHooks = reactHooksImport.default ?? reactHooksImport;

/** @type {import("eslint").Linter.FlatConfig[]} */
module.exports = [
  {
    ignores: ["dist/**", "build/**", "coverage/**", "node_modules/**", "src/vendor/**"],
  },
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react-refresh": reactRefresh,
      "react-hooks": reactHooks,
    },
    rules: {
      ...(tsPlugin.configs?.recommended?.rules ?? {}),
      ...(reactHooks.configs?.recommended?.rules ?? {}),
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
];