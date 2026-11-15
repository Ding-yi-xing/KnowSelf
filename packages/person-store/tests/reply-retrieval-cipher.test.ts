import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { createPersonStore } from "../src/store";
import { EncryptionKeyInvalidError } from "../src/errors";
import { deriveReplyRetrievalKey, ensureReplyRetrievalSalt, openDerivedCipherDb } from "../src/crypto/cipher";
import { makeTempDir, removeTempDir } from "./helpers";

const ROOT_KEY = Buffer.alloc(32, 0x2a);
const WRONG_KEY = Buffer.alloc(32, 0x7b);

describe("reply-retrieval cipher boundary", () => {
  it("derives a stable key for the same root key and salt", () => {
    const salt = Buffer.alloc(32, 0x19);
    expect(deriveReplyRetrievalKey(ROOT_KEY, salt)).toEqual(
      deriveReplyRetrievalKey(ROOT_KEY, salt),
    );
    expect(deriveReplyRetrievalKey(ROOT_KEY, salt)).not.toEqual(
      deriveReplyRetrievalKey(ROOT_KEY, Buffer.alloc(32, 0x20)),
    );
  });

  it("creates and reuses a fixed-size salt atomically", () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, "reply-retrieval.salt");
      const first = ensureReplyRetrievalSalt(path);
      const second = ensureReplyRetrievalSalt(path);
      expect(first).toHaveLength(32);
      expect(second).toEqual(first);
    } finally {
      removeTempDir(dir);
    }
  });

  it("opens, closes, and reopens an encrypted derived database", () => {
    const dir = makeTempDir();
    const personsPath = join(dir, "persons.sqlite");
    const replyPath = join(dir, "reply-retrieval.sqlite");
    const saltPath = join(dir, "reply-retrieval.salt");
    let persons = createPersonStore({
      dbPath: personsPath,
      encryption: { mode: "sqlcipher", env: { KNOWSELF_PERSONS_KEY: ROOT_KEY.toString("base64") } },
    });
    const reply = persons.openReplyRetrievalDb(replyPath, saltPath);
    reply.raw.exec("CREATE TABLE secrets (value TEXT NOT NULL)");
    reply.prepare("INSERT INTO secrets (value) VALUES (?)").run("SYNTHETIC_REPLY_HISTORY");
    reply.close();
    persons.close();

    const fileBytes = readFileSync(replyPath);
    expect(fileBytes.includes(Buffer.from("SYNTHETIC_REPLY_HISTORY"))).toBe(false);

    persons = createPersonStore({
      dbPath: personsPath,
      encryption: { mode: "sqlcipher", env: { KNOWSELF_PERSONS_KEY: ROOT_KEY.toString("base64") } },
    });
    const reopened = persons.openReplyRetrievalDb(replyPath, saltPath);
    expect(reopened.prepare("SELECT value FROM secrets").get()).toEqual({
      value: "SYNTHETIC_REPLY_HISTORY",
    });
    reopened.close();
    persons.close();
    removeTempDir(dir);
  });

  it("fails closed for a wrong key and a plain SQLite open", () => {
    const dir = makeTempDir();
    const path = join(dir, "reply-retrieval.sqlite");
    const salt = Buffer.alloc(32, 0x31);
    const db = openDerivedCipherDb(path, ROOT_KEY, salt);
    db.raw.exec("CREATE TABLE sensitive (value TEXT NOT NULL)");
    db.prepare("INSERT INTO sensitive (value) VALUES (?)").run("SYNTHETIC_SECRET");
    db.close();

    expect(() => openDerivedCipherDb(path, WRONG_KEY, salt)).toThrow(EncryptionKeyInvalidError);

    const plain = new Database(path);
    expect(() => plain.prepare("SELECT count(*) AS n FROM sqlite_master").get()).toThrow();
    plain.close();
    removeTempDir(dir);
  });

  it("requires the encrypted persons root before opening a derived database", () => {
    const dir = makeTempDir();
    const persons = createPersonStore({
      dbPath: join(dir, "persons.sqlite"),
      encryption: { mode: "none" },
    });
    try {
      expect(() =>
        persons.openReplyRetrievalDb(join(dir, "reply.sqlite"), join(dir, "reply.salt")),
      ).toThrow("requires an encrypted persons store");
    } finally {
      persons.close();
      removeTempDir(dir);
    }
  });
});
