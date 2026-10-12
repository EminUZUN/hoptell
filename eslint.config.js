import js from "@eslint/js";
import globals from "globals";

export default [
  // The shipped binding glue is generated (wasm-bindgen, native/openmls-wasm/build.sh), not edited.
  { ignores: ["lib/mls/binding/"] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: globals.node },
    // `catch {}` marks best-effort steps (cleanup, diagnostics) on purpose.
    rules: { "no-empty": ["error", { allowEmptyCatch: true }] },
  },
];
