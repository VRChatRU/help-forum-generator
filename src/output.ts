import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isAssetPath, isThreadId } from "./archive";
import type { Archive, Asset, Page, PageMeta } from "./archive";

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

function legacyAssetPaths(html: string, threadId: string): Set<string> {
  const paths = new Set<string>();
  const base = new URL(`https://legacy.invalid/threads/${threadId}/index.html`);
  new HTMLRewriter()
    .on("[src], [poster], a[href]", {
      element(element) {
        for (const attribute of ["src", "poster", "href"]) {
          const raw = element.getAttribute(attribute);
          if (!raw || !/^(?:\.\.\/\.\.\/|\/)assets\//.test(raw)) continue;
          try {
            const url = new URL(decodeAttribute(raw), base);
            const path = decodeURIComponent(url.pathname.slice(1));
            if (url.origin === base.origin && isAssetPath(path))
              paths.add(path);
          } catch {
            // A malformed legacy URL cannot refer to a local generated asset.
          }
        }
      },
    })
    .transform(html);
  return paths;
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
      let page: Page;
      const assets: Asset[] = [];
      try {
        const meta = legacyMeta(
          await Bun.file(join(dir, "meta.json")).json(),
          threadId,
        );
        const html = await Bun.file(join(dir, "index.html")).text();
        const assetPaths = [];
        for (const path of legacyAssetPaths(html, threadId)) {
          if (!this.archive.hasAsset(path)) {
            try {
              assets.push({
                path,
                bytes: await Bun.file(join(root, path)).bytes(),
              });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
              onIssue?.(`Missing asset for legacy page ${threadId}: ${path}`);
              continue;
            }
          }
          assetPaths.push(path);
        }
        page = { ...meta, html, assetPaths };
      } catch (error) {
        onIssue?.(`Could not read legacy page ${threadId}`, error);
        continue;
      }
      this.archive.save(page, assets);
      imported++;
    }
    return imported;
  }

  async restore(): Promise<number> {
    for (const threadId of this.archive.listUnpublished())
      await this.removePage(threadId);
    const published = this.archive.list();
    const writtenAssets = new Set<string>();
    for (const { threadId } of published) {
      const page = this.archive.get(threadId);
      if (page?.published) await this.writePage(page, writtenAssets);
    }
    return published.length;
  }

  async writePage(
    page: Page,
    writtenAssets = new Set<string>(),
  ): Promise<void> {
    const dir = this.threadDir(page.threadId);
    for (const path of page.assetPaths) {
      if (writtenAssets.has(path)) continue;
      const bytes = this.archive.getAsset(path);
      if (!bytes) throw new Error(`Missing archived asset: ${path}`);
      await writeAtomic(this.assetFile(path), bytes);
      writtenAssets.add(path);
    }

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
    await this.removeUnlistedAssets(threadId);
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

  private async removeUnlistedAssets(threadId: string): Promise<void> {
    for (const path of this.archive.unlistedThreadAssets(threadId)) {
      await rm(this.assetFile(path), { force: true });
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
