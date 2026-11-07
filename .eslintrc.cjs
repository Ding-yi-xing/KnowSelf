/* eslint-env node */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    project: [
      "./tsconfig.json",
      "./apps/*/tsconfig.json",
      "./packages/*/tsconfig.json",
      "./apps/*/tsconfig.test.json",
      "./packages/*/tsconfig.test.json",
    ],
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended-type-checked", "prettier"],
  ignorePatterns: [
    "dist/",
    "node_modules/",
    "data/",
    "coverage/",
    "playwright-report/",
    "test-results/",
    "apps/desktop/src-tauri/target/",
    "docs/",
    "*.config.cjs",
    "*.config.ts",
    "*.config.js",
  ],
  rules: {
    // 项目规则上限：见 docs/DESIGN.md §5
    "@typescript-eslint/consistent-type-imports": "error",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/require-await": "off",
    "no-console": ["warn", { allow: ["warn", "error"] }],
  },
  overrides: [
    {
      files: ["**/tests/**", "**/*.test.ts", "**/*.spec.ts"],
      rules: {
        "@typescript-eslint/no-explicit-any": "off",
      },
    },
    {
      // provider-adapter 的 adapter 层对接外部 API，边界处允许 any
      files: ["packages/provider-adapter/src/adapter/*.ts"],
      rules: {
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/no-unsafe-return": "off",
      },
    },
    {
      // 测试文件中 mock / 断言不可避免的 any 操作
      files: ["**/tests/**", "**/*.test.ts", "**/*.spec.ts", "apps/web/e2e/**"],
      rules: {
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/no-unsafe-return": "off",
        "@typescript-eslint/unbound-method": "off",
        "@typescript-eslint/restrict-template-expressions": "off",
        "@typescript-eslint/no-base-to-string": "off",
      },
    },
    {
      // server 源码：SQLite 查询 / Hono 中间件边界处不可避免的弱类型
      files: ["apps/server/src/**/*.ts"],
      rules: {
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/no-unsafe-return": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/restrict-template-expressions": "off",
        "@typescript-eslint/no-base-to-string": "off",
        "@typescript-eslint/no-floating-promises": "off",
        "@typescript-eslint/unbound-method": "off",
      },
    },
    {
      // packages 源码中的弱类型（SQLite / 外部 API 返回）
      files: ["packages/*/src/**/*.ts"],
      rules: {
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/no-unsafe-return": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/restrict-template-expressions": "off",
        "@typescript-eslint/no-base-to-string": "off",
        "@typescript-eslint/unbound-method": "off",
      },
    },
  ],
};
