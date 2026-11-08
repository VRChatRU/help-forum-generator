import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Archive } from "../src/archive";
import { legacySnapshot } from "../src/legacy";
import type { ThreadSnapshot } from "../src/model";

const createdAt = "2026-11-08T10:00:00.000Z";
const replyDate = "2026-11-08T10:01:00.000Z";
const threadId = (
  (BigInt(Date.parse(createdAt)) - 1420070400000n) <<
  22n
).toString();
const replyId = (
  (BigInt(Date.parse(replyDate)) - 1420070400000n) <<
  22n
).toString();
const meta = { threadId, title: "Question", createdAt, excerpt: "Description" };
const legacyHtml = `<html><body>
  <div class="tags"><span class="tag"><img src="../../assets/tags/tag.png" alt="">VR</span></div>
  <article class="group"><header>
    <img src="../../assets/avatars/avatar-321.png" alt="Alice">
    <h3 style="color: #abcdef">Alice &amp; Bob<img src="../../assets/roles/role.png" alt=""></h3>
    <time datetime="${createdAt}">Date</time>
  </header><section>
    <div class="message" id="m-${threadId}" data-answer="false"><div class="body">
      <p>First &amp; second<br><a href="https://docs.example/guide#install">Guide</a></p>
      <p>Next <code>line</code> <img class="inline-emoji" src="../../assets/emojis/wave.png" alt="wave"></p>
      <pre><code>def function():
    first = 1
    if first:
        return first
</code></pre>
      <table><tr><th>Setting</th><th>Value</th></tr><tr><td>Quality</td><td>High</td></tr></table>
      <a href="../../assets/${threadId}/photo.png"><img src="../../assets/${threadId}/photo.png" alt="Private photo"></a>
      <video><source src="https://cdn.discordapp.com/attachments/video.mp4"></video>
      <div class="attachment"><strong>Private file.zip</strong><a download href="../../assets/${threadId}/file.bin">Download</a></div>
      <a href="https://cdn.discordapp.com/attachments/private.pdf">Private remote file</a>
    </div><div class="reactions"><span class="reaction"><span class="emoji">👍</span><em>2</em></span></div></div>
    <div class="message" id="m-${replyId}" data-answer="true"><div class="body">
      <div class="reply"><a href="#m-${threadId}">Quoted author</a><p>Old quoted content</p></div>
      <p>Solution &#x27;works&#39;.</p>
    </div><div class="reactions"><span class="reaction"><img class="emoji" src="../../assets/emojis/yes.png" alt="yes"><em>1</em></span></div></div>
  </section></article>
</body></html>`;

async function fixture(run: (path: string) => Promise<void>): Promise<void> {
  const directory = import.meta.dir;
  const prefix = ".help-forum-archive-";
  const root = await mkdtemp(join(directory, prefix));
  try {
    await run(join(root, "archive.db"));
  } finally {
    if (dirname(root) === directory && basename(root).startsWith(prefix))
      await rm(root, { recursive: true, force: true });
  }
}

function legacyDatabase(path: string, html = legacyHtml): void {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE pages (threadId TEXT PRIMARY KEY, title TEXT, createdAt TEXT, excerpt TEXT, html TEXT, published INTEGER);
      CREATE TABLE assets (path TEXT PRIMARY KEY, bytes BLOB);
      CREATE TABLE page_assets (threadId TEXT REFERENCES pages(threadId), path TEXT REFERENCES assets(path));
    `);
    db.query("INSERT INTO pages VALUES (?, ?, ?, ?, ?, ?)").run(
      threadId,
      meta.title,
      createdAt,
      meta.excerpt,
      html,
      0,
    );
    db.query("INSERT INTO assets VALUES (?, ?)").run(
      "assets/private.bin",
      new Uint8Array(2 * 1024 * 1024),
    );
    db.query("INSERT INTO page_assets VALUES (?, ?)").run(
      threadId,
      "assets/private.bin",
    );
  } finally {
    db.close();
  }
}

test("legacy messages retain text, code indentation, links and structure without files", () => {
  const snapshot = legacySnapshot(meta, legacyHtml);
  const [starter, reply] = snapshot.messages;
  expect(snapshot.tags).toEqual(["VR"]);
  expect(snapshot.messages).toHaveLength(2);
  expect(starter).toMatchObject({
    id: threadId,
    authorId: "321",
    authorName: "Alice & Bob",
    authorColor: "#abcdef",
    createdAt,
    replyTo: null,
    answer: false,
    reactions: [{ name: "👍", count: 2 }],
  });
  expect(starter!.content).toContain(
    "First & second\nGuide (https://docs.example/guide#install)",
  );
  expect(starter!.content).toContain("Next `line` wave");
  expect(starter!.content).toContain(
    "```\ndef function():\n    first = 1\n    if first:\n        return first\n```",
  );
  expect(starter!.content).toContain("Setting | Value |");
  expect(starter!.content).toContain("Quality | High |");
  expect(JSON.stringify(snapshot)).not.toMatch(
    /assets\/|discordapp\.com|Private photo|Private file|Private remote/,
  );
  expect(reply).toMatchObject({
    id: replyId,
    createdAt: replyDate,
    content: "Solution 'works'.",
    replyTo: threadId,
    answer: true,
    reactions: [{ name: "yes", count: 1 }],
  });
});

test("legacy SQLite migration keeps messages and publication state and removes BLOB storage", async () => {
  await fixture(async (path) => {
    legacyDatabase(path);
    const previousSize = Bun.file(path).size;
    const expected = legacySnapshot(meta, legacyHtml);
    const archive = new Archive(path);
    try {
      expect(archive.migration).toEqual({
        threads: 1,
        messages: 2,
        resumed: false,
      });
      expect(archive.get(threadId)).toEqual({
        ...expected,
        published: false,
        sourceMissing: false,
      });
      expect(archive.list()).toEqual([]);
      expect(archive.listUnpublished()).toEqual([threadId]);
      expect(archive.setSourceMissing(threadId, true)).toBe(true);
      expect(archive.setSourceMissing(threadId, true)).toBe(false);
      expect(archive.setPublished(threadId, true)).toBe(true);
    } finally {
      archive.close();
    }

    expect(Bun.file(path).size).toBeLessThan(previousSize / 4);
    const db = new Database(path, { readonly: true });
    try {
      expect(
        db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all()
          .map(({ name }) => name),
      ).toEqual(["messages", "threads"]);
      expect(
        db.query<{ user_version: number }, []>("PRAGMA user_version").get()!
          .user_version,
      ).toBe(2);
    } finally {
      db.close();
    }

    const reopened = new Archive(path);
    try {
      expect(reopened.migration).toBeUndefined();
      expect(reopened.get(threadId)).toEqual({
        ...expected,
        published: true,
        sourceMissing: true,
      });
      reopened.save(expected);
      expect(reopened.get(threadId)).toEqual({
        ...expected,
        published: true,
        sourceMissing: false,
      });
    } finally {
      reopened.close();
    }
  });
});

test("a failed message replacement rolls back the complete thread snapshot", () => {
  const archive = new Archive(":memory:");
  try {
    const snapshot = legacySnapshot(meta, legacyHtml);
    archive.save(snapshot);
    archive.setPublished(threadId, false);
    archive.setSourceMissing(threadId, true);
    const invalid: ThreadSnapshot = {
      ...snapshot,
      title: "Invalid replacement",
      messages: [snapshot.messages[0]!, snapshot.messages[0]!],
    };
    expect(() => archive.save(invalid)).toThrow();
    expect(archive.get(threadId)).toEqual({
      ...snapshot,
      published: false,
      sourceMissing: true,
    });
  } finally {
    archive.close();
  }
});

test("unrecognizable legacy HTML leaves the original database intact", async () => {
  await fixture(async (path) => {
    legacyDatabase(path, "<html><body>Unrecognized page</body></html>");
    expect(() => new Archive(path)).toThrow("No messages found");
    const db = new Database(path, { readonly: true });
    try {
      expect(
        db
          .query<{ count: number }, []>("SELECT count(*) count FROM pages")
          .get()!.count,
      ).toBe(1);
      expect(
        db
          .query<{ count: number }, []>("SELECT count(*) count FROM assets")
          .get()!.count,
      ).toBe(1);
      expect(
        db
          .query(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
          )
          .get(),
      ).toBeNull();
      expect(
        db.query<{ user_version: number }, []>("PRAGMA user_version").get()!
          .user_version,
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});

test("an interrupted post-migration cleanup resumes and reclaims free pages", async () => {
  await fixture(async (path) => {
    const archive = new Archive(path);
    try {
      archive.save(legacySnapshot(meta, legacyHtml));
    } finally {
      archive.close();
    }
    const db = new Database(path);
    try {
      db.exec(
        "CREATE TABLE discarded (bytes BLOB); INSERT INTO discarded VALUES (zeroblob(2097152)); DROP TABLE discarded; PRAGMA user_version = 1;",
      );
    } finally {
      db.close();
    }
    const previousSize = Bun.file(path).size;
    const resumed = new Archive(path);
    try {
      expect(resumed.migration).toEqual({
        threads: 1,
        messages: 2,
        resumed: true,
      });
      expect(resumed.get(threadId)?.messages).toHaveLength(2);
    } finally {
      resumed.close();
    }
    expect(Bun.file(path).size).toBeLessThan(previousSize / 4);
  });
});
