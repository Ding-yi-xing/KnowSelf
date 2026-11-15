/**
 * @knowself/contracts — 单一真相源
 *
 * 阶段 3 实施时：从 docs/shared/contracts/*.ts 抄录每个文件为 src/<name>.ts，
 * 在每个 schema / type 前加 `export`。本 index.ts 仅 re-export。
 *
 * 对应文档：docs/shared/contracts/{profile,chat,provider,tool,mcp,retrieval,settings,source,system}.ts
 */

export * from "./profile";
export * from "./chat";
export * from "./provider";
export * from "./tool";
export * from "./mcp";
export * from "./retrieval";
export * from "./settings";
export * from "./source";
export * from "./system";
export * from "./sync";
export * from "./template";
export * from "./chat-ingest";
export * from "./mining";
export * from "./person";
export * from "./person-detail";
export * from "./semantic";
export * from "./ability";
