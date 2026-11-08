import { expect, test } from "bun:test";
import type { Message, ThreadChannel } from "discord.js";
import {
  renderArchivedThread,
  renderSite,
  renderThread,
} from "../src/render.ts";
import type { ThreadSnapshot } from "../src/model.ts";

test("renders live media and captures a text snapshot before downloading assets", async () => {
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
            title: "Embedded guide",
            description: "Text from the guide",
            fields: [{ name: "Step", value: "Read the instructions" }],
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
      undefined,
      (snapshot) => {
        expect(downloads).toEqual([]);
        expect(snapshot.messages[0]?.content).toContain(":test:");
        expect(snapshot.messages[0]?.content).not.toContain(
          "https://example.com/image.jpg",
        );
      },
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
    const archived = JSON.stringify(page.snapshot);
    expect(archived).not.toContain("attachments/");
    expect(archived).not.toContain("preview.jpg");
    expect(archived).not.toContain("booth-img-fix.js");
    expect(page.snapshot.messages[1]?.content).toContain("Text from the guide");
    expect(page.snapshot.messages[1]?.content).toContain(
      "Read the instructions",
    );
    expect(page.snapshot.messages[1]?.replyTo).toBe("345");
    expect(page.snapshot.messages[1]?.answer).toBe(true);

    const site = await renderSite([page], config);
    expect(site.index).toContain('href="threads/345/"');
    expect(site.sitemap).toContain("https://help.vrcru.org/help/threads/345/");
    expect(site.robots).toContain("https://help.vrcru.org/help/sitemap.xml");
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test("renders archived messages with the current layout and text only", async () => {
  const snapshot: ThreadSnapshot = {
    threadId: "345",
    title: "Archived question",
    createdAt: "2024-01-01T12:00:00.000Z",
    excerpt: "A saved question",
    tags: ["Guide <script>"],
    messages: [
      {
        id: "345",
        authorId: "123",
        authorName: "Author <script>",
        authorColor: "#abcdef",
        createdAt: "2024-01-01T12:00:00.000Z",
        content:
          "Question **saved** @Member :wave: ![Inline alt](https://example.com/image.png) <a:wave:555>\n\n[Guide](https://example.com/guide) https://example.com/animation.gif\n\n| Heading |\n|---|\n| Cell |",
        replyTo: null,
        answer: false,
        reactions: [{ name: ":wave:", count: 2 }],
      },
      {
        id: "346",
        authorId: "123",
        authorName: "Author <script>",
        authorColor: "#abcdef",
        createdAt: "2024-01-01T12:01:00.000Z",
        content: "A reply with `code`",
        replyTo: "345",
        answer: true,
        reactions: [],
      },
    ],
  };
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("Archived rendering must not request remote resources");
    },
    { preconnect: fetchOriginal.preconnect },
  );
  try {
    const config = {
      BASE_URL: "https://help.vrcru.org/",
      GUILD_ID: "234",
      PUBLISH_EMOJI: "🌐",
      ANSWER_EMOJI: "✅",
      SITE_TITLE: "База знаний VRChatRU",
      SITE_DESCRIPTION: "Описание",
    };
    const page = await renderArchivedThread(snapshot, config);
    expect(page.html).toContain("<strong>saved</strong>");
    expect(page.html).toContain("<table>");
    expect(page.html).toContain("Inline alt");
    expect(page.html).toContain("Author &lt;script&gt;");
    expect(page.html).toContain('href="https://example.com/guide"');
    expect(page.html).toContain('href="https://example.com/animation.gif"');
    expect(page.html).toContain('href="#m-346">Ответ 1');
    expect(page.html).toContain('href="#m-345"');
    expect(page.html).toContain('data-answer="true"');
    expect(page.html).toContain('<span class="emoji">:wave:</span><em>2</em>');
    expect(page.html.match(/<article class="group">/g)).toHaveLength(1);
    expect(page.html).not.toMatch(/<(?:video|audio|source|iframe)\b/);
    let messageImages = 0;
    new HTMLRewriter()
      .on(".group img", {
        element() {
          messageImages++;
        },
      })
      .transform(page.html);
    expect(messageImages).toBe(0);
    expect(page.html).toContain('alt="VRChatRU logo"');
    expect(page.html).not.toContain("https://example.com/image.png");
    expect(page.html).not.toContain("cdn.discordapp.com");
    expect(page.html).not.toContain("og:image");
    expect(page.assetPaths).toEqual([]);
    const legacyPage = await renderArchivedThread(
      {
        ...snapshot,
        messages: snapshot.messages.map((message, index) => ({
          ...message,
          authorId: "",
          authorName: `Legacy author ${index}`,
        })),
      },
      config,
    );
    expect(legacyPage.html.match(/<article class="group">/g)).toHaveLength(2);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});
