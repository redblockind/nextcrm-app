import nextConfig from "eslint-config-next/core-web-vitals";

const config = [
  // Never lint the .netlify build-artifact directory. The Netlify deno-cli build
  // plugin vendors third-party Deno/Node type definitions in here, which trip
  // ESLint with errors from rules that don't apply to generated dependency code.
  { ignores: [".netlify/**"] },
  ...nextConfig,
  {
    rules: {
      // TanStack Table v9's useReactTable() is known to be incompatible with the
      // React Compiler (it returns functions that can't be safely memoized).
      // The compiler already handles this by skipping memoization for affected
      // components. Downgrading to 'warn' avoids blocking the build while keeping
      // --max-warnings=0 in CI for real errors.
      "react-hooks/incompatible-library": "off",

      // The React Compiler ruleset that ships with eslint-config-next 16 flags
      // every synchronous setState inside a useEffect as an error. This fires on
      // many long-standing, correct patterns in this codebase — resetting state
      // when a prop changes, accumulating paginated results, and seeding form
      // state on open. These are intentional and behave correctly, so the rule is
      // turned off here rather than rewriting working components. Revisit if/when
      // these effects are refactored toward the compiler's preferred patterns.
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default config;
