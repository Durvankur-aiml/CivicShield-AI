import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // "Tactical Civic Command" token discipline: informational text uses the
  // cs-secondary tier; cs-muted stays reserved for decorative/tertiary roles.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/text-cs-muted/ ]",
          message: "Use text-cs-secondary for informational text (cs-muted is decorative only).",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Python venv bundles third-party JS we must not lint:
    "vision-service/.venv/**",
    "**/__pycache__/**",
  ]),
]);

export default eslintConfig;
