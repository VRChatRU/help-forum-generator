import { expect, test } from "bun:test";
import type { Message, ThreadChannel } from "discord.js";
import { renderSite, renderThread } from "../src/render.ts";

test("renders answers and archives Discord media while escaping forum content", async () => {
  const fetchOriginal = globalThis.fetch;
  const downloads: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: URL | string | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      downloads.push(url.hostname);
      return new Response(new Uint8Array([1, 2, 3]));
    },
    { preconnect: fetchOriginal.preconnect },
  );

  try {
    const createdAt = new Date("2024-01-01T12:00:00Z");
    const guild = {
      roles: { cache: new Map() },
      channels: { cache: new Map() },
    };
    const thread = {
      id: "345",
      name: "Тема <script>",
      url: "https://discord.com/channels/234/345",
      appliedTags: [],
      createdAt,
      guild,
    } as unknown as ThreadChannel;
    const author = { id: "123", username: "Имя" };
    const member = {
      displayName: "<script>alert(1)</script>",
      displayHexColor: "#abcdef",
      displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png",
      roles: { cache: new Map() },
    };
    const messages = [
      {
        id: thread.id,
        content:
          "Вопрос **жирным** <@123> <a:test:555> <https://example.com/?a=1&b=2> [скрипт](jav&#x61;script:alert) ![внешняя картинка](https://example.com/image.jpg) <img src=x onerror=alert(1)>\n\n| Столбец |\n|---|\n| Ячейка |",
      },
      {
        id: "346",
        content: "Ответ",
        reference: { messageId: thread.id },
        attachments: new Map([
          [
            "567",
            {
              url: "https://cdn.discordapp.com/attachments/345/567/image.png?ex=123",
              name: "image.png",
              contentType: "image/png",
            },
          ],
          [
            "568",
            {
              url: "https://cdn.discordapp.com/attachments/345/568/booth-img-fix.js?ex=123",
              name: "booth-img-fix.js",
              contentType: "text/javascript",
            },
          ],
          [
            "569",
            {
              url: "https://example.com/document.pdf",
              name: "A & B.pdf",
              contentType: "application/pdf",
            },
          ],
        ]),
        embeds: [
          {
            thumbnail: {
              url: "https://example.com/preview.jpg",
              proxyURL:
                "https://images-ext-1.discordapp.net/external/example/preview.jpg",
            },
          },
        ],
      },
    ].map((message) => ({
      channelId: thread.id,
      author,
      member,
      guild,
      createdAt,
      createdTimestamp: createdAt.getTime(),
      mentions: {
        users: new Map([[author.id, author]]),
        members: new Map([[author.id, member]]),
      },
      reactions: { cache: new Map() },
      attachments: new Map(),
      embeds: [],
      ...message,
    })) as unknown as Message[];
    const config = {
      BASE_URL: "https://help.vrcru.org/help",
      GUILD_ID: "234",
      FORUM_CHANNEL_ID: "333",
      PUBLISH_EMOJI: "🌐",
      ANSWER_EMOJI: "✅",
      SITE_TITLE: "База знаний VRChatRU",
      SITE_DESCRIPTION: "Описание",
    };
    const assets = new Map<string, Uint8Array>();
    const page = await renderThread(
      thread,
      messages,
      config,
      {
        get: (path) => assets.has(path),
        add: (path, bytes) => {
          assets.set(path, bytes);
        },
      },
      async (message) => message.id === "346",
    );

    expect(page.html).toContain("<strong>жирным</strong>");
    expect(page.html).toContain("<table>");
    expect(page.html).toContain('class="mention"');
    expect(page.html).toContain('class="inline-emoji"');
    expect(page.html).toContain('href="#m-346">Ответ 1');
    expect(page.html).toContain('href="#m-345"');
    expect(page.html).toContain('href="https://example.com/?a=1&amp;b=2"');
    expect(page.html).toContain('src="https://example.com/image.jpg"');
    expect(page.html).toContain('<div class="attachment">');
    expect(page.html).toContain("<strong>booth-img-fix.js</strong>");
    expect(page.html).toMatch(
      /href="\.\.\/\.\.\/assets\/345\/[a-f0-9]{64}\.bin" download="booth-img-fix\.js" aria-label="Скачать booth-img-fix\.js">Скачать<\/a>/,
    );
    expect(page.html).toMatch(/<img src="[^"]+" alt="image\.png"/);
    expect(page.html).not.toContain('download="image.png"');
    expect(page.html).not.toContain("<strong>image.png</strong>");
    expect(page.html).toContain(
      'href="https://example.com/document.pdf" target="_blank" rel="noopener noreferrer" aria-label="Открыть A &amp; B.pdf">Открыть</a>',
    );
    expect(page.html).not.toContain("<script>");
    expect(page.html).not.toContain("<img src=x");
    expect(page.html).not.toContain('href="javascript:');
    expect([...page.assetPaths].sort()).toEqual([...assets.keys()].sort());
    expect(downloads.sort()).toEqual([
      "cdn.discordapp.com",
      "cdn.discordapp.com",
      "cdn.discordapp.com",
      "cdn.discordapp.com",
      "images-ext-1.discordapp.net",
    ]);

    const site = await renderSite([page], config);
    expect(site.index).toContain('href="threads/345/"');
    expect(site.sitemap).toContain("https://help.vrcru.org/help/threads/345/");
    expect(site.robots).toContain("https://help.vrcru.org/help/sitemap.xml");
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});
