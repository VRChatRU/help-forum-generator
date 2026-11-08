import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Archive } from "../src/archive";
import type { ThreadSnapshot } from "../src/model";
import { SiteOutput } from "../src/output";

const snapshot: ThreadSnapshot = {
  threadId: "123",
  title: "Вопрос",
  createdAt: "2026-10-30T13:00:00.000Z",
  excerpt: "Описание",
  tags: [],
  messages: [
    {
      id: "123",
      authorId: "456",
      authorName: "Автор",
      authorColor: "#abcdef",
      createdAt: "2026-10-30T13:00:00.000Z",
      content: "Сохранённый **текст**",
      replyTo: null,
      answer: true,
      reactions: [],
    },
  ],
};
const config = {
  GUILD_ID: "456",
  PUBLISH_EMOJI: "🌐",
  ANSWER_EMOJI: "✅",
  SITE_TITLE: "База знаний",
  SITE_DESCRIPTION: "Описание",
};
const image = `assets/123/${"a".repeat(64)}.png`;
const script = `assets/123/${"b".repeat(64)}.bin`;
const livePage = {
  ...snapshot,
  html: `<img src="../../${image}"><a href="../../${script}" download="тест &amp; &#x27;file&#x27;.js">Скачать</a>`,
  assetPaths: [image, script],
};

async function fixture(run: (root: string) => Promise<void>) {
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

test("keeps live media on disk and restores missing sources as text only", async () => {
  await fixture(async (root) => {
    const archive = new Archive(join(root, "archive.db"));
    try {
      const output = new SiteOutput(root, archive);
      archive.save(snapshot);
      await output.writeAsset(image, new Uint8Array([1, 2, 3]));
      await output.writeAsset(script, new Uint8Array([4, 5, 6]));
      await output.writePage(livePage);
      const pageFile = Bun.file(join(root, "threads/123/index.html"));
      expect(await output.hasAsset(image)).toBe(true);
      expect(await pageFile.text()).toContain(
        `href="../../${script}?download=%D1%82%D0%B5%D1%81%D1%82%20%26%20%27file%27.js"`,
      );
      const liveHtml = await pageFile.text();
      expect(await output.restore(config, true)).toBe(1);
      expect(await pageFile.text()).toBe(liveHtml);

      archive.setSourceMissing("123", true);
      expect(await output.restore(config, true)).toBe(1);
      const restored = await pageFile.text();
      expect(restored).toContain("Сохранённый <strong>текст</strong>");
      expect(restored).not.toMatch(/<(?:video|audio)\b/);
      expect(restored).not.toContain('src="../../assets/');
      expect(restored).not.toContain("download=");
      expect(await output.hasAsset(image)).toBe(false);
      expect(await output.hasAsset(script)).toBe(false);
      expect(archive.get("123")?.messages).toEqual(snapshot.messages);

      await Bun.write(join(root, "threads/123/manual.txt"), "keep");
      archive.setPublished("123", false);
      expect(await output.restore(config)).toBe(0);
      expect(await pageFile.exists()).toBe(false);
      expect(await Bun.file(join(root, "threads/123/meta.json")).exists()).toBe(
        false,
      );
      expect(await Bun.file(join(root, "threads/123/manual.txt")).text()).toBe(
        "keep",
      );
      expect(archive.get("123")?.messages).toEqual(snapshot.messages);
    } finally {
      archive.close();
    }
  });
});

test("imports legacy text without reading media and does not republish hidden threads", async () => {
  await fixture(async (root) => {
    const legacy = join(root, "legacy");
    await Bun.write(
      join(legacy, "threads/123/meta.json"),
      JSON.stringify(snapshot),
    );
    await Bun.write(
      join(legacy, "threads/123/index.html"),
      `
      <article class="group"><header><img src="../../assets/avatars/missing.png"><div><h3>Автор</h3><time datetime="${snapshot.createdAt}">Дата</time></div></header>
      <div class="message" id="m-123" data-answer="true"><div class="body"><p>Старый текст <a href="https://example.com/guide">инструкция</a></p></div><div class="attachment"><a href="../../assets/123/missing.bin" download="file.bin">Скачать</a></div></div></article>`,
    );
    const archive = new Archive(join(root, "archive.db"));
    try {
      const output = new SiteOutput(join(root, "website"), archive);
      expect(await output.importLegacy(legacy)).toBe(1);
      expect(archive.get("123")?.messages[0]?.content).toContain(
        "Старый текст",
      );
      expect(archive.get("123")?.messages[0]?.content).toContain(
        "https://example.com/guide",
      );
      expect(JSON.stringify(archive.get("123"))).not.toContain("missing");
      expect(await output.restore(config)).toBe(1);
      archive.setPublished("123", false);
      expect(await output.importLegacy(legacy)).toBe(0);
      expect(await output.restore(config)).toBe(0);
    } finally {
      archive.close();
    }
  });
});
