import Database from "better-sqlite3";
import { openConversationsDb } from "./apps/server/src/persistence/db.ts";
const db = openConversationsDb(":memory:");
console.log("DB open ok");
db.close();
console.log("DB close ok");
