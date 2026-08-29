import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// eslint-config-next 16 ships native flat configs; the FlatCompat shim it
// used to need is gone.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // eslint-plugin-react-hooks 7 adds this for React Compiler readiness.
      // This app does not use the compiler, and every site it flags is either
      // a mount-time read of browser storage (the hydration-safe pattern) or
      // "clear the list, then fetch". Those are correct; rewriting them to
      // satisfy the rule would be churn in the largest component for no
      // runtime change. Revisit if the React Compiler is ever adopted.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  globalIgnores([
    ".claude/**",
    "node_modules/**",
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
  ]),
]);
