import { Database } from "bun:sqlite";

export type PageMeta = {
  threadId: string;
  title: string;
  createdAt: string;
  excerpt: string;
};

export type Page = PageMeta & {
  html: string;
  assetPaths: readonly string[];
};

export type StoredPage = Page & { published: boolean };
export type Asset = { path: string; bytes: Uint8Array };

type PageRow = PageMeta & { html: string; published: number };
type PathRow = { path: string };
type ThreadRow = { threadId: string };

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

export class Archive {
  private readonly db: Database;
  private readonly saveTransaction: (
    page: Page,
    assets: readonly Asset[],
  ) => void;

  constructor(path: string) {
    this.db = new Database(path, { strict: true });
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS pages (
        threadId TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        html TEXT NOT NULL,
        published INTEGER NOT NULL CHECK (published IN (0, 1))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS assets (
        path TEXT PRIMARY KEY,
        bytes BLOB NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS page_assets (
        threadId TEXT NOT NULL REFERENCES pages(threadId),
        path TEXT NOT NULL REFERENCES assets(path),
        PRIMARY KEY (threadId, path)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS published_pages ON pages (published, createdAt DESC, threadId DESC);
      CREATE INDEX IF NOT EXISTS asset_pages ON page_assets (path);
    `);

    const saveAsset = this.db.query<unknown, [string, Uint8Array]>(`
      INSERT INTO assets (path, bytes) VALUES (?, ?)
      ON CONFLICT (path) DO UPDATE SET bytes = excluded.bytes
    `);
    const savePage = this.db.query<
      unknown,
      [string, string, string, string, string]
    >(`
      INSERT INTO pages (threadId, title, createdAt, excerpt, html, published) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT (threadId) DO UPDATE SET title = excluded.title, createdAt = excluded.createdAt,
        excerpt = excluded.excerpt, html = excluded.html, published = 1
    `);
    const clearLinks = this.db.query<unknown, [string]>(
      "DELETE FROM page_assets WHERE threadId = ?",
    );
    const linkAsset = this.db.query<unknown, [string, string]>(
      "INSERT INTO page_assets VALUES (?, ?)",
    );

    this.saveTransaction = this.db.transaction(
      (page: Page, assets: readonly Asset[]) => {
        if (!isThreadId(page.threadId))
          throw new Error(`Invalid Discord thread ID: ${page.threadId}`);
        const paths = new Set(page.assetPaths);
        for (const path of paths) {
          if (!isAssetPath(path))
            throw new Error(`Invalid asset path: ${path}`);
        }

        for (const asset of assets) {
          if (!paths.has(asset.path)) continue;
          saveAsset.run(asset.path, asset.bytes);
        }

        savePage.run(
          page.threadId,
          page.title,
          new Date(page.createdAt).toISOString(),
          page.excerpt,
          page.html,
        );
        clearLinks.run(page.threadId);
        for (const path of paths) {
          if (!this.hasAsset(path))
            throw new Error(`Missing archived asset: ${path}`);
          linkAsset.run(page.threadId, path);
        }
      },
    ).immediate;
  }

  close(): void {
    this.db.close();
  }

  hasPage(threadId: string): boolean {
    return (
      this.db
        .query<unknown, [string]>("SELECT 1 FROM pages WHERE threadId = ?")
        .get(threadId) !== null
    );
  }

  get(threadId: string): StoredPage | null {
    const page = this.db
      .query<PageRow, [string]>("SELECT * FROM pages WHERE threadId = ?")
      .get(threadId);
    if (!page) return null;
    const assetPaths = this.db
      .query<PathRow, [string]>(
        "SELECT path FROM page_assets WHERE threadId = ? ORDER BY path",
      )
      .all(threadId)
      .map(({ path }) => path);
    return { ...page, assetPaths, published: page.published === 1 };
  }

  list(): PageMeta[] {
    return this.db
      .query<PageMeta, []>(
        `
      SELECT threadId, title, createdAt, excerpt FROM pages
      WHERE published = 1 ORDER BY createdAt DESC, threadId DESC
    `,
      )
      .all();
  }

  listUnpublished(): string[] {
    return this.db
      .query<ThreadRow, []>("SELECT threadId FROM pages WHERE published = 0")
      .all()
      .map(({ threadId }) => threadId);
  }

  save(page: Page, assets: readonly Asset[] = []): void {
    this.saveTransaction(page, assets);
  }

  storeAsset(path: string, bytes: Uint8Array): void {
    if (!isAssetPath(path)) throw new Error(`Invalid asset path: ${path}`);
    this.db
      .query<unknown, [string, Uint8Array]>(
        "INSERT INTO assets (path, bytes) VALUES (?, ?) ON CONFLICT (path) DO NOTHING",
      )
      .run(path, bytes);
  }

  setPublished(threadId: string, published: boolean): boolean {
    return (
      this.db
        .query<unknown, [number, string, number]>(
          `
      UPDATE pages SET published = ? WHERE threadId = ? AND published != ?
    `,
        )
        .run(Number(published), threadId, Number(published)).changes > 0
    );
  }

  getAsset(path: string): Uint8Array | null {
    return (
      this.db
        .query<{ bytes: Uint8Array }, [string]>(
          "SELECT bytes FROM assets WHERE path = ?",
        )
        .get(path)?.bytes ?? null
    );
  }

  hasAsset(path: string): boolean {
    return (
      this.db
        .query<unknown, [string]>("SELECT 1 FROM assets WHERE path = ?")
        .get(path) !== null
    );
  }

  unlistedThreadAssets(threadId: string): string[] {
    return this.db
      .query<PathRow, [string]>(
        `
      SELECT path FROM assets WHERE path GLOB ? AND NOT EXISTS (
        SELECT 1 FROM page_assets JOIN pages USING (threadId)
        WHERE page_assets.path = assets.path AND pages.published = 1
      )
    `,
      )
      .all(`assets/${threadId}/*`)
      .map(({ path }) => path);
  }
}
