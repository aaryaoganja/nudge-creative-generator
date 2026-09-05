import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

// eslint-config-next v16 ships native flat configs, so no @eslint/eslintrc
// FlatCompat layer is needed (and the compat layer in fact crashes on it).
const config = [
  {
    ignores: ["node_modules/**", ".next/**", "src/generated/**", ".railway/**"],
  },
  ...coreWebVitals,
  ...typescript,
];

export default config;
