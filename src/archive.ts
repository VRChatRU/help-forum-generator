import { Database } from "bun:sqlite";
import { legacySnapshot } from "./legacy";
import type {
  ArchivedMessage,
  PageMeta,
  StoredThread,
  ThreadSnapshot,
} from "./model";

export type {
  ArchivedMessage,
  Page,
  PageMeta,
  StoredThread,
  ThreadSnapshot,
} from "./model";

type ThreadRow = PageMeta & {
  tags: string;
  published: number;
  sourceMissing: number;
};
type MessageRow = Omit<ArchivedMessage, "answer" | "reactions"> & {
  answer: number;
  reactions: string;
};
type LegacyRow = PageMeta & { html: string; published: number };
type Migration = { threads: number; messages: number; resumed: boolean };

const pendingCleanupVersion = 1;
const schemaVersion = 2;

export function isThreadId(value: string): boolean {
  return /^\d{1,20}$/.test(value);
}

export function isAssetPath(value: string): boolean {
  const parts = value.split("/");
  return (
    parts[0] === "assets" &&
    parts.length >= 3 &&
    parts.every(
      (part) =>
        part &&
        !/[. ]$/.test(part) &&
        !/[\x00-\x1f<>:"\\|?*]/.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
    )
  );
}

function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      threadId TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      tags TEXT NOT NULL CHECK (json_valid(tags)),
      published INTEGER NOT NULL CHECK (published IN (0, 1)),
      sourceMissing INTEGER NOT NULL CHECK (sourceMissing IN (0, 1))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS messages (
      threadId TEXT NOT NULL REFERENCES threads(threadId) ON DELETE CASCADE,
      id TEXT NOT NULL,
      authorId TEXT NOT NULL,
      authorName TEXT NOT NULL,
      authorColor TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      content TEXT NOT NULL,
      replyTo TEXT,
      answer INTEGER NOT NULL CHECK (answer IN (0, 1)),
      reactions TEXT NOT NULL CHECK (json_valid(reactions)),
      PRIMARY KEY (threadId, id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS published_threads ON threads (published, createdAt DESC, threadId DESC);
  `);
}

function saveSnapshot(db: Database, snapshot: ThreadSnapshot): void {
  if (!isThreadId(snapshot.threadId))
    throw new Error(`Invalid Discord thread ID: ${snapshot.threadId}`);
  if (!snapshot.messages.length)
    throw new Error(`No messages for thread ${snapshot.threadId}`);

  db.query<unknown, [string, string, string, string, string]>(
    `
    INSERT INTO threads (threadId, title, createdAt, excerpt, tags, published, sourceMissing)
    VALUES (?, ?, ?, ?, ?, 1, 0)
    ON CONFLICT (threadId) DO UPDATE SET title = excluded.title, createdAt = excluded.createdAt,
      excerpt = excluded.excerpt, tags = excluded.tags, published = 1, sourceMissing = 0
  `,
  ).run(
    snapshot.threadId,
    snapshot.title,
    new Date(snapshot.createdAt).toISOString(),
    snapshot.excerpt,
    JSON.stringify(snapshot.tags),
  );

  db.query<unknown, [string]>("DELETE FROM messages WHERE threadId = ?").run(
    snapshot.threadId,
  );
  const insert = db.query<
    unknown,
    [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string | null,
      number,
      string,
    ]
  >(`
    INSERT INTO messages (threadId, id, authorId, authorName, authorColor, createdAt, content, replyTo, answer, reactions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const message of snapshot.messages) {
    if (!isThreadId(message.id))
      throw new Error(`Invalid Discord message ID: ${message.id}`);
    insert.run(
      snapshot.threadId,
      message.id,
      message.authorId,
      message.authorName,
      message.authorColor,
      new Date(message.createdAt).toISOString(),
      message.content,
      message.replyTo,
      Number(message.answer),
      JSON.stringify(message.reactions),
    );
  }
}

function checkpoint(db: Database): void {
  const result = db
    .query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
    .get();
  if (result?.busy)
    throw new Error(
      "Could not finish archive migration while another process is using the database",
    );
}

function migrate(db: Database): Migration | undefined {
  const version =
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()
      ?.user_version ?? 0;
  if (version > schemaVersion)
    throw new Error(`Unsupported archive schema version: ${version}`);

  if (version === 0) {
    const legacy =
      db
        .query<unknown, []>(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pages'",
        )
        .get() !== null;
    db.transaction(() => {
      createSchema(db);
      if (legacy) {
        for (const page of db
          .query<LegacyRow, []>("SELECT * FROM pages")
          .iterate()) {
          saveSnapshot(db, legacySnapshot(page, page.html));
          if (!page.published)
            db.query<unknown, [string]>(
              "UPDATE threads SET published = 0 WHERE threadId = ?",
            ).run(page.threadId);
        }
        db.exec(
          "DROP TABLE IF EXISTS page_assets; DROP TABLE IF EXISTS assets; DROP TABLE pages;",
        );
      }
      db.exec(
        `PRAGMA user_version = ${legacy ? pendingCleanupVersion : schemaVersion}`,
      );
    }).immediate();
  }

  const current = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()?.user_version;
  if (current === pendingCleanupVersion) {
    db.exec("VACUUM");
    checkpoint(db);
    db.exec(`PRAGMA user_version = ${schemaVersion}`);
    checkpoint(db);
    return {
      threads: db
        .query<{ count: number }, []>("SELECT count(*) count FROM threads")
        .get()!.count,
      messages: db
        .query<{ count: number }, []>("SELECT count(*) count FROM messages")
        .get()!.count,
      resumed: version === pendingCleanupVersion,
    };
  }
}

export class Archive {
  readonly migration?: Migration;
  private readonly db: Database;
  private readonly saveTransaction: (snapshot: ThreadSnapshot) => void;

  constructor(path: string) {
    this.db = new Database(path, { strict: true });
    try {
      this.db.exec(
        "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;",
      );
      this.migration = migrate(this.db);
      this.saveTransaction = this.db.transaction((snapshot: ThreadSnapshot) =>
        saveSnapshot(this.db, snapshot),
      ).immediate;
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  hasPage(threadId: string): boolean {
    return (
      this.db
        .query<unknown, [string]>("SELECT 1 FROM threads WHERE threadId = ?")
        .get(threadId) !== null
    );
  }

  get(threadId: string): StoredThread | null {
    const thread = this.db
      .query<ThreadRow, [string]>("SELECT * FROM threads WHERE threadId = ?")
      .get(threadId);
    if (!thread) return null;
    const messages = this.db
      .query<MessageRow, [string]>(
        `
      SELECT id, authorId, authorName, authorColor, createdAt, content, replyTo, answer, reactions
      FROM messages WHERE threadId = ? ORDER BY createdAt, length(id), id
    `,
      )
      .all(threadId)
      .map((message) => ({
        ...message,
        answer: message.answer === 1,
        reactions: JSON.parse(
          message.reactions,
        ) as ArchivedMessage["reactions"],
      }));
    return {
      ...thread,
      tags: JSON.parse(thread.tags) as string[],
      messages,
      published: thread.published === 1,
      sourceMissing: thread.sourceMissing === 1,
    };
  }

  list(): PageMeta[] {
    return this.db
      .query<PageMeta, []>(
        `
      SELECT threadId, title, createdAt, excerpt FROM threads
      WHERE published = 1 ORDER BY createdAt DESC, threadId DESC
    `,
      )
      .all();
  }

  listUnpublished(): string[] {
    return this.db
      .query<{ threadId: string }, []>(
        "SELECT threadId FROM threads WHERE published = 0",
      )
      .all()
      .map(({ threadId }) => threadId);
  }

  save(snapshot: ThreadSnapshot): void {
    this.saveTransaction(snapshot);
  }

  setPublished(threadId: string, published: boolean): boolean {
    return (
      this.db
        .query<unknown, [number, string, number]>(
          `
      UPDATE threads SET published = ? WHERE threadId = ? AND published != ?
    `,
        )
        .run(Number(published), threadId, Number(published)).changes > 0
    );
  }

  setSourceMissing(threadId: string, missing: boolean): boolean {
    return (
      this.db
        .query<unknown, [number, string, number]>(
          `
      UPDATE threads SET sourceMissing = ? WHERE threadId = ? AND sourceMissing != ?
    `,
        )
        .run(Number(missing), threadId, Number(missing)).changes > 0
    );
  }
}
