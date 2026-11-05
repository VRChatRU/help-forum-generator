import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Archive } from "../src/archive";
import type { Page } from "../src/archive";
import { SiteOutput } from "../src/output";

const attachment = "assets/123/a & b.png";
const avatar = "assets/avatars/avatar.png";
const script = `assets/123/${"a".repeat(64)}.bin`;
const page: Page = {
  threadId: "123",
  title: "Вопрос",
  createdAt: "2026-10-30T13:00:00.000Z",
  excerpt: "Описание",
  html: `<img src="../../assets/avatars/avatar.png"><a href="../../assets/123/a%20&amp;%20b.png">Файл</a><a href="../../${script}" download="тест &amp; &#x27;file&#x27;.js">Скачать</a>`,
  assetPaths: [attachment, script, avatar],
};
const outputHtml = page.html.replace(
  `href="../../${script}"`,
  `href="../../${script}?download=%D1%82%D0%B5%D1%81%D1%82%20%26%20%27file%27.js"`,
);

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const temp = import.meta.dir;
  const prefix = ".help-forum-archive-";
  const root = await mkdtemp(join(temp, prefix));
  try {
    await run(root);
  } finally {
    if (dirname(root) === temp && basename(root).startsWith(prefix))
      await rm(root, { recursive: true, force: true });
  }
}

test("imports legacy pages and restores HTML, metadata and assets from SQLite alone", async () => {
  await fixture(async (root) => {
    const legacy = join(root, "legacy");
    const published = join(root, "published");
    const dbPath = join(root, "archive.db");
    const legacyThread = join(legacy, "threads", page.threadId);
    const outputThread = join(published, "threads", page.threadId);
    await Bun.write(join(legacyThread, "index.html"), page.html);
    await Bun.write(join(legacyThread, "meta.json"), JSON.stringify(page));
    await Bun.write(join(legacy, attachment), "attachment");
    await Bun.write(join(legacy, avatar), "avatar");
    await Bun.write(join(legacy, script), "script");

    const importer = new Archive(dbPath);
    try {
      const output = new SiteOutput(published, importer);
      expect(await output.importLegacy(legacy)).toBe(1);
      expect(await output.importLegacy(legacy)).toBe(0);
    } finally {
      importer.close();
    }

    const archive = new Archive(dbPath);
    try {
      const output = new SiteOutput(published, archive);
      expect(await output.restore()).toBe(1);
      expect(await Bun.file(join(outputThread, "index.html")).text()).toBe(
        outputHtml,
      );
      expect(await Bun.file(join(outputThread, "meta.json")).json()).toEqual({
        threadId: page.threadId,
        title: page.title,
        createdAt: page.createdAt,
        excerpt: page.excerpt,
        pageRelPath: "threads/123/index.html",
      });
      expect(await Bun.file(join(published, attachment)).text()).toBe(
        "attachment",
      );
      expect(await Bun.file(join(published, avatar)).text()).toBe("avatar");
      await Bun.write(join(outputThread, "index.html"), "damaged projection");
      expect(await output.restore()).toBe(1);
      expect(await Bun.file(join(outputThread, "index.html")).text()).toBe(
        outputHtml,
      );

      const unmanaged = join(outputThread, "manual.txt");
      await Bun.write(unmanaged, "keep");
      expect(archive.setPublished(page.threadId, false)).toBe(true);
      expect(await output.importLegacy(legacy)).toBe(0);
      expect(await output.restore()).toBe(0);
      expect(await Bun.file(join(outputThread, "index.html")).exists()).toBe(
        false,
      );
      expect(await Bun.file(join(published, attachment)).exists()).toBe(false);
      expect(await Bun.file(unmanaged).text()).toBe("keep");
      expect(archive.get(page.threadId)).toEqual({ ...page, published: false });
      expect(archive.hasAsset(attachment)).toBe(true);
    } finally {
      archive.close();
    }
  });
});

test("a failed snapshot write leaves the previous page and assets intact", () => {
  const archive = new Archive(":memory:");
  try {
    archive.save({ ...page, assetPaths: [] }, []);
    expect(() =>
      archive.save(
        {
          ...page,
          title: "Invalid replacement",
          assetPaths: [attachment, avatar],
        },
        [{ path: attachment, bytes: new Uint8Array([42]) }],
      ),
    ).toThrow(`Missing archived asset: ${avatar}`);
    expect(archive.get(page.threadId)).toEqual({
      ...page,
      assetPaths: [],
      published: true,
    });
    expect(archive.hasAsset(attachment)).toBe(false);
  } finally {
    archive.close();
  }
});
