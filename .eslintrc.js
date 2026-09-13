module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2022: true
  },
  // eslint-config-prettier (via plugin:prettier/recommended) turns off every
  // stylistic rule that would fight the formatter, so quote style etc. is
  // Prettier's job -- the old `quotes: ["error", "double"]` here contradicted
  // .prettierrc's singleQuote: true.
  extends: ["eslint:recommended", "plugin:prettier/recommended"],
  plugins: ["prettier"],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "script"
  },
  rules: {
    "prettier/prettier": "warn",
    "no-console": process.env.NODE_ENV === "production" ? "warn" : "off",
    "no-debugger": process.env.NODE_ENV === "production" ? "warn" : "off",
    // Unused function arguments are pervasive in the express handlers; unused
    // variables are what we actually care about.
    "no-unused-vars": ["warn", { args: "none", ignoreRestSiblings: true }],
    "no-empty": ["error", { allowEmptyCatch: true }],
    // `!!value` in a boolean position is all over this codebase and is harmless.
    "no-extra-boolean-cast": "off",
    // Redundant escapes inside regex and string literals. Not auto-fixable, and
    // hand-editing a regex to remove a no-op backslash risks changing what it
    // matches for no functional gain -- surfaced as a warning instead.
    "no-useless-escape": "warn"
  },
  overrides: [
    {
      // The client is ES modules; jplist publishes itself as a global for the
      // EJS data-jplist-* controls, and CLIENT_VERSION is injected by webpack.
      files: ["client/js/**/*.js", "client/entry/**/*.js"],
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
      globals: {
        jplist: "readonly",
        bootbox: "readonly",
        $: "readonly",
        CLIENT_VERSION: "readonly"
      }
    }
  ]
};
