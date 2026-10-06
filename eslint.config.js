import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: globals.node },
    // `catch {}` marks best-effort steps (cleanup, diagnostics) on purpose.
    rules: { "no-empty": ["error", { allowEmptyCatch: true }] },
  },
];
