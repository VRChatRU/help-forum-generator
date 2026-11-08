import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isAssetPath, isThreadId } from "./archive";
import type { Archive, Page, PageMeta } from "./archive";
import { legacySnapshot } from "./legacy";
import { renderArchivedThread, type RenderConfig } from "./render";

export type SiteFiles = {
  index: string;
  css: string;
  sitemap?: string;
  robots?: string;
};

async function writeAtomic(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const previous = Bun.file(path);
  try {
    if (
      typeof content === "string"
        ? (await previous.text()) === content
        : previous.size === content.byteLength &&
          Buffer.compare(await previous.bytes(), content) === 0
    )
      return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${Bun.randomUUIDv7()}.tmp`);
  try {
    await Bun.write(temp, content);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function legacyMeta(value: unknown, threadId: string): PageMeta {
  if (
    typeof value === "object" &&
    value !== null &&
    "threadId" in value &&
    value.threadId === threadId &&
    "title" in value &&
    typeof value.title === "string" &&
    "excerpt" in value &&
    typeof value.excerpt === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt))
  ) {
    return {
      threadId,
      title: value.title,
      excerpt: value.excerpt,
      createdAt: value.createdAt,
    };
  }
  throw new Error("Invalid legacy meta.json");
}

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  "#x27": "'",
};

function decodeAttribute(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot|apos|#39|#x27);/gi,
    (match, entity: string) => entities[entity.toLowerCase()] ?? match,
  );
}

const archivedDownload =
  /^(?:\.\.\/\.\.\/|\/)assets\/\d{1,20}\/[a-f0-9]{64}\.[a-z0-9]+$/;

function nameDownloads(html: string): string {
  return new HTMLRewriter()
    .on("a[download][href]", {
      element(link) {
        const href = link.getAttribute("href");
        const name = link.getAttribute("download");
        if (!href || !name || !archivedDownload.test(href)) return;

        const filename = decodeAttribute(name).replace(
          /[\\/\x00-\x1f\x7f]/g,
          "_",
        );
        const encoded = encodeURIComponent(filename.toWellFormed()).replace(
          /[!'()*]/g,
          (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
        );
        link.setAttribute("href", `${href}?download=${encoded}`);
      },
    })
    .transform(html);
}

export class SiteOutput {
  constructor(
    private readonly root: string,
    private readonly archive: Archive,
  ) {}

  async importLegacy(
    root = this.root,
    onIssue?: (message: string, error?: unknown) => void,
  ): Promise<number> {
    const threads = join(root, "threads");
    let entries;
    try {
      entries = await readdir(threads, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }

    let imported = 0;
    for (const entry of entries) {
      const threadId = entry.name;
      if (
        !entry.isDirectory() ||
        !isThreadId(threadId) ||
        this.archive.hasPage(threadId)
      )
        continue;
      const dir = join(threads, threadId);
      try {
        const meta = legacyMeta(
          await Bun.file(join(dir, "meta.json")).json(),
          threadId,
        );
        const html = await Bun.file(join(dir, "index.html")).text();
        this.archive.save(legacySnapshot(meta, html));
      } catch (error) {
        onIssue?.(`Could not read legacy page ${threadId}`, error);
        continue;
      }
      imported++;
    }
    return imported;
  }

  async restore(
    config: RenderConfig,
    preserveExisting = false,
  ): Promise<number> {
    for (const threadId of this.archive.listUnpublished())
      await this.removePage(threadId);
    const published = this.archive.list();
    for (const { threadId } of published) {
      const thread = this.archive.get(threadId);
      if (!thread?.published) continue;
      if (
        preserveExisting &&
        !thread.sourceMissing &&
        (await Bun.file(join(this.threadDir(threadId), "index.html")).exists())
      )
        continue;
      await this.writePage(await renderArchivedThread(thread, config));
    }
    return published.length;
  }

  async hasAsset(path: string): Promise<boolean> {
    return Bun.file(this.assetFile(path)).exists();
  }

  async writeAsset(path: string, bytes: Uint8Array): Promise<void> {
    await writeAtomic(this.assetFile(path), bytes);
  }

  async writePage(page: Page): Promise<void> {
    const dir = this.threadDir(page.threadId);

    const { threadId, title, createdAt, excerpt, html } = page;
    const pageRelPath = `threads/${threadId}/index.html`;
    await writeAtomic(
      join(dir, "meta.json"),
      JSON.stringify(
        { threadId, title, createdAt, excerpt, pageRelPath },
        null,
        2,
      ),
    );
    await writeAtomic(join(dir, "index.html"), nameDownloads(html));
    await this.removeUnlistedAssets(threadId, new Set(page.assetPaths));
  }

  async removePage(threadId: string): Promise<void> {
    const dir = this.threadDir(threadId);
    const page = this.archive.get(threadId);
    if (!page || page.published) return;
    await rm(join(dir, "index.html"), { force: true });
    await rm(join(dir, "meta.json"), { force: true });
    await this.removeUnlistedAssets(threadId);
  }

  async writeSite(files: SiteFiles): Promise<void> {
    await writeAtomic(join(this.root, "assets", "style.css"), files.css);
    if (files.sitemap !== undefined)
      await writeAtomic(join(this.root, "sitemap.xml"), files.sitemap);
    if (files.robots !== undefined)
      await writeAtomic(join(this.root, "robots.txt"), files.robots);
    await writeAtomic(join(this.root, "index.html"), files.index);
  }

  private async removeUnlistedAssets(
    threadId: string,
    keep = new Set<string>(),
  ): Promise<void> {
    const dir = join(this.root, "assets", threadId);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.[a-z0-9]+$/.test(entry.name))
        continue;
      const path = `assets/${threadId}/${entry.name}`;
      if (!keep.has(path)) await rm(this.assetFile(path), { force: true });
    }
  }

  private threadDir(threadId: string): string {
    if (!isThreadId(threadId))
      throw new Error(`Invalid Discord thread ID: ${threadId}`);
    return join(this.root, "threads", threadId);
  }

  private assetFile(path: string): string {
    if (!isAssetPath(path)) throw new Error(`Invalid asset path: ${path}`);
    return join(this.root, path);
  }
}
