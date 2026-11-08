import {
  ChannelType,
  escapeMarkdown,
  type GuildMember,
  type Message,
  type ThreadChannel,
  type User,
} from "discord.js";
import type {
  ArchivedMessage,
  Page,
  PageMeta,
  ThreadSnapshot,
} from "./model.ts";
import {
  assetUrl,
  mediaFile,
  ThreadAssets,
  webUrl,
  type RenderAssets,
} from "./render/assets.ts";
import {
  archiveImage,
  customEmoji,
  externalLink,
  image,
  renderMarkdown,
  renderTextMarkdown,
  shortText,
} from "./render/markdown.ts";

export type RenderConfig = {
  BASE_URL?: string | URL;
  GUILD_ID: string;
  FORUM_CHANNEL_ID?: string;
  PUBLISH_EMOJI: string;
  ANSWER_EMOJI: string;
  SITE_TITLE: string;
  SITE_DESCRIPTION: string;
};

type Profile = {
  name: string;
  color: string;
  avatar: string | null;
  roleIcon: string | null;
};

const escape = Bun.escapeHTML;
const GROUP_INTERVAL = 10 * 60_000;
const DEFAULT_COLOR = "#8b949e";
const DATE_FORMAT = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  dateStyle: "short",
  timeStyle: "short",
});
const TEMPLATES = new URL("../templates/", import.meta.url);
let templateFiles: Promise<[string, string, string]> | undefined;

function templates() {
  return (templateFiles ??= Promise.all([
    Bun.file(new URL("index.html", TEMPLATES)).text(),
    Bun.file(new URL("thread.html", TEMPLATES)).text(),
    Bun.file(new URL("style.css", TEMPLATES)).text(),
  ]));
}

function fill(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(
    /\{\{(\w+)}}/g,
    (original, key: string) => values[key] ?? original,
  );
}

function baseUrl(config: RenderConfig): URL | undefined {
  if (!config.BASE_URL) return;
  const url = new URL(config.BASE_URL);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  url.search = "";
  url.hash = "";
  return url;
}

function seo(
  title: string,
  description: string,
  canonical?: URL,
  ogImage?: URL,
) {
  return {
    description_tag: `<meta name="description" content="${escape(description)}">`,
    canonical_tag: canonical
      ? `<link rel="canonical" href="${escape(canonical.href)}">`
      : "",
    meta_extra: [
      `<meta property="og:title" content="${escape(title)}">`,
      `<meta property="og:description" content="${escape(description)}">`,
      ogImage
        ? `<meta property="og:image" content="${escape(ogImage.href)}">`
        : "",
    ]
      .filter(Boolean)
      .join("\n  "),
  };
}

export async function renderSite(
  pages: Iterable<PageMeta>,
  config: RenderConfig,
): Promise<{ index: string; css: string; sitemap?: string; robots?: string }> {
  const [template, , css] = await templates();
  const items = Array.from(pages).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const base = baseUrl(config);
  const now = new Date();
  const index = fill(template, {
    title: escape(config.SITE_TITLE),
    site_title: escape(config.SITE_TITLE),
    forum_url: `https://discord.com/channels/${escape(config.GUILD_ID || "666306330230915093")}/${escape(config.FORUM_CHANNEL_ID || "1019662051825680404")}`,
    style_href: "assets/style.css",
    updated_at: escape(DATE_FORMAT.format(now)),
    items: items
      .map(
        (page) => `    <li>
      <a href="threads/${escape(page.threadId)}/">${escape(page.title)}</a>
      <time datetime="${escape(page.createdAt)}">${escape(DATE_FORMAT.format(new Date(page.createdAt)))}</time>
      <p>${escape(page.excerpt)}</p>
    </li>`,
      )
      .join("\n"),
    ...seo(config.SITE_TITLE, config.SITE_DESCRIPTION, base),
  });
  if (!base) return { index, css };

  const urls = [
    { url: base, date: items[0]?.createdAt ?? now.toISOString() },
    ...items.map((page) => ({
      url: new URL(`threads/${page.threadId}/`, base),
      date: page.createdAt,
    })),
  ];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(({ url, date }) => `  <url><loc>${escape(url.href)}</loc><lastmod>${escape(date.slice(0, 10))}</lastmod></url>`).join("\n")}
</urlset>
`;
  return {
    index,
    css,
    sitemap,
    robots: `User-agent: *\nAllow: /\n\nSitemap: ${new URL("sitemap.xml", base).href}\n`,
  };
}

function color(value: string | undefined): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) && value !== "#000000"
    ? value
    : DEFAULT_COLOR;
}

async function loadProfile(
  thread: ThreadChannel,
  user: User,
  known?: GuildMember | null,
): Promise<Profile> {
  let member = known;
  if (!member) {
    try {
      member = await thread.guild.members.fetch(user.id);
    } catch (error) {
      // Former server members and webhooks can still have messages in a thread.
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        (error.code !== 10007 && error.code !== 10013)
      )
        throw error;
    }
  }
  const role =
    member &&
    [...member.roles.cache.values()]
      .filter((item) => item.icon)
      .sort((a, b) => b.comparePositionTo(a))[0];
  return {
    name: member?.displayName ?? user.displayName ?? user.username,
    color: color(member?.displayHexColor),
    avatar: (member ?? user).displayAvatarURL({
      extension: "png",
      size: 128,
      forceStatic: true,
    }),
    roleIcon: role?.iconURL({ extension: "png", size: 64 }) ?? null,
  };
}

type DisplaySource = {
  id: string;
  authorId: string;
  createdAt: Date;
  profile: Profile;
  excerpt(limit: number): string;
};

type Source = DisplaySource & {
  mention(syntax: string): string;
  text(content: string): string;
};

type MessageGroup = { source: DisplaySource; last: number; messages: string[] };

async function sourceMessage(
  message: Message,
  getProfile: (user: User, member?: GuildMember | null) => Promise<Profile>,
): Promise<Source> {
  const [profile, users] = await Promise.all([
    getProfile(message.author, message.member),
    Promise.all(
      [...message.mentions.users.values()].map(
        async (user) =>
          [
            user.id,
            await getProfile(user, message.mentions.members?.get(user.id)),
          ] as const,
      ),
    ),
  ]);
  const mentions = new Map(users);

  function display(syntax: string): { name: string; color: string } {
    const match = /^(@!?|@&|#)(\d+)$/.exec(syntax);
    if (match?.[1] === "@&") {
      const role = message.guild?.roles.cache.get(match[2]!);
      if (role) return { name: "@" + role.name, color: color(role.hexColor) };
    } else if (match?.[1] === "#") {
      const channel = message.guild?.channels.cache.get(match[2]!);
      if (channel) return { name: "#" + channel.name, color: DEFAULT_COLOR };
    } else if (match) {
      const member = mentions.get(match[2]!);
      if (member) return { name: "@" + member.name, color: member.color };
    }
    return { name: "<" + syntax + ">", color: DEFAULT_COLOR };
  }

  function resolveContent(content: string, markdown: boolean): string {
    return content
      .replace(/<(@!?[0-9]+|@&[0-9]+|#[0-9]+)>/g, (_, syntax: string) => {
        const name = display(syntax).name;
        return markdown ? escapeMarkdown(name) : name;
      })
      .replace(/<a?:([a-z0-9_]+):[0-9]+>/gi, ":$1:")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  }

  return {
    id: message.id,
    authorId: message.author.id,
    createdAt: message.createdAt,
    profile,
    mention(syntax) {
      const value = display(syntax);
      return `<span class="mention" style="color: ${value.color}">${escape(value.name)}</span>`;
    },
    text(content) {
      return resolveContent(content, true);
    },
    excerpt(limit) {
      return shortText(resolveContent(message.content, false), limit);
    },
  };
}

async function loadTags(thread: ThreadChannel) {
  if (!thread.appliedTags.length || !thread.parentId) return [];
  const parent =
    thread.parent ?? (await thread.guild.channels.fetch(thread.parentId));
  if (
    parent?.type !== ChannelType.GuildForum &&
    parent?.type !== ChannelType.GuildMedia
  )
    return [];

  const byId = new Map(parent.availableTags.map((tag) => [tag.id, tag]));
  return thread.appliedTags.flatMap((id) => {
    const tag = byId.get(id);
    return tag ? [tag] : [];
  });
}

async function renderTags(
  thread: ThreadChannel,
  tags: Awaited<ReturnType<typeof loadTags>>,
  assets: ThreadAssets,
): Promise<string> {
  const rendered = await Promise.all(
    tags.map(async (tag) => {
      const emoji = tag.emoji;
      const icon = emoji?.id
        ? await customEmoji(
            emoji.id,
            emoji.name ?? "",
            Boolean(thread.guild.emojis.cache.get(emoji.id)?.animated),
            assets,
            "tag",
          )
        : emoji?.name
          ? `<span class="tag-emoji">${escape(emoji.name)}</span>`
          : "";
      return `<span class="tag">${icon}${escape(tag.name)}</span>`;
    }),
  );
  return rendered.some(Boolean)
    ? `<div class="tags">${rendered.join("")}</div>`
    : "";
}

async function renderReactions(
  message: Message,
  config: RenderConfig,
  assets: ThreadAssets,
): Promise<string> {
  const control = new Set([config.PUBLISH_EMOJI, config.ANSWER_EMOJI]);
  const badges = await Promise.all(
    [...message.reactions.cache.values()].map(async ({ emoji, count }) => {
      const key = emoji.id ?? emoji.name ?? "";
      if (
        !key ||
        count <= 0 ||
        control.has(key) ||
        (emoji.name && control.has(emoji.name))
      )
        return "";
      const rendered = emoji.id
        ? await customEmoji(
            emoji.id,
            emoji.name ?? "emoji",
            Boolean(emoji.animated),
            assets,
            "reaction",
          )
        : `<span class="emoji">${escape(key)}</span>`;
      return `<span class="reaction">${rendered}<em>${count}</em></span>`;
    }),
  );
  return badges.some(Boolean)
    ? `<div class="reactions">${badges.join("")}</div>`
    : "";
}

type Media = { html: string; ogImage?: string };

async function renderMedia(
  message: Message,
  assets: ThreadAssets,
  proxyBySource: ReadonlyMap<string, string>,
): Promise<Media[]> {
  const attachments = [...message.attachments.values()].map(
    async (attachment): Promise<Media> => {
      const remote = webUrl(attachment.url);
      if (!remote) return { html: "" };
      const { extension, kind } = mediaFile(
        remote.href,
        attachment.contentType,
      );
      const path = await assets.localize(
        remote.href,
        message.channelId,
        extension,
      );
      const source = path ? assetUrl(path) : remote.href;
      const label = attachment.name ?? "Вложение";
      if (kind === "image") {
        return {
          html: externalLink(source, image(source, label)),
          ogImage: path ?? source,
        };
      }

      const filename = escape(label);
      const action = path ? "Скачать" : "Открыть";
      const linkAttributes = path
        ? `download="${filename}"`
        : 'target="_blank" rel="noopener noreferrer"';
      const card = `<div class="attachment">
  <div class="attachment__file"><small>Вложение</small><strong>${filename}</strong></div>
  <a class="attachment__action" href="${escape(source)}" ${linkAttributes} aria-label="${action} ${filename}">${action}</a>
</div>`;
      switch (kind) {
        case "video":
          return {
            html: `<video controls preload="none"><source src="${escape(source)}"></video>${card}`,
          };
        case "audio":
          return {
            html: `<audio controls preload="none" src="${escape(source)}"></audio>${card}`,
          };
        default:
          return { html: card };
      }
    },
  );
  const previews = [...proxyBySource].map(
    async ([source, proxy]): Promise<Media> => {
      const preview = await archiveImage(
        source,
        proxy,
        assets,
        message.channelId,
      );
      return preview
        ? {
            html: externalLink(
              preview.src,
              image(preview.src, "Предпросмотр ссылки"),
            ),
            ogImage: preview.ogImage,
          }
        : { html: "" };
    },
  );
  return Promise.all([...attachments, ...previews]);
}

function renderReply(source: DisplaySource | undefined): string {
  if (!source) return "";
  const text = source.excerpt(80);
  return `<div class="reply">
  <span>Ответ на <a href="#m-${escape(source.id)}" style="color: ${source.profile.color}">${escape(source.profile.name)}</a></span>
  ${text ? `<p>${escape(text)}</p>` : ""}
</div>`;
}

async function renderGroup(
  source: DisplaySource,
  messages: string[],
  assets?: ThreadAssets,
): Promise<string> {
  const { createdAt, profile } = source;
  const [avatar, role] = await Promise.all([
    assets &&
      profile.avatar &&
      assets.localize(profile.avatar, "avatars", "png"),
    assets &&
      profile.roleIcon &&
      assets.localize(profile.roleIcon, "roles", "png"),
  ]);
  return `<article class="group">
  <header>
    ${avatar ? `<img src="${escape(assetUrl(avatar))}" alt="${escape(profile.name)}" width="48" height="48" loading="lazy" decoding="async">` : ""}
    <div>
      <h3 style="color: ${profile.color}">${escape(profile.name)}${
        role
          ? `<img class="role-icon" src="${escape(assetUrl(role))}" alt="" width="18" height="18" loading="lazy" decoding="async">`
          : ""
      }</h3>
      <time datetime="${createdAt.toISOString()}">${escape(DATE_FORMAT.format(createdAt))}</time>
    </div>
  </header>
  <section>
${messages.join("\n")}
  </section>
</article>`;
}

function renderMessage(
  id: string,
  body: string,
  answer: boolean,
  reactions: string,
): string {
  return `<div id="m-${escape(id)}" class="message" data-answer="${answer}">
  <div class="meta">${answer ? '<span class="badge">Ответ</span>' : ""}</div>
  <div class="body">${body}</div>
  ${reactions}
</div>`;
}

function appendMessage(
  groups: MessageGroup[],
  source: DisplaySource,
  html: string,
): void {
  const group = groups.at(-1);
  const timestamp = source.createdAt.getTime();
  if (
    group?.source.authorId === source.authorId &&
    (source.authorId || group.source.profile.name === source.profile.name) &&
    timestamp - group.last <= GROUP_INTERVAL
  ) {
    group.messages.push(html);
    group.last = timestamp;
  } else {
    groups.push({ source, last: timestamp, messages: [html] });
  }
}

async function threadPage(
  snapshot: ThreadSnapshot,
  config: RenderConfig,
  groups: MessageGroup[],
  tagsHtml: string,
  assets?: ThreadAssets,
  firstImage?: string,
): Promise<Page> {
  const [, template] = await templates();
  const renderedGroups: string[] = [];
  for (const group of groups) {
    renderedGroups.push(
      await renderGroup(group.source, group.messages, assets),
    );
  }
  const answers = snapshot.messages
    .filter((message) => message.answer)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (answers.length) {
    const links = answers.map(
      (message, index) =>
        `<a href="#m-${escape(message.id)}">Ответ ${index + 1}</a>`,
    );
    renderedGroups.splice(
      1,
      0,
      `<nav class="answers-nav"><span>Ответы:</span>${links.join("")}</nav>`,
    );
  }

  const base = baseUrl(config);
  const canonical = base && new URL(`threads/${snapshot.threadId}/`, base);
  const description =
    `${snapshot.excerpt} (VRChat, врчат, вр чат, vr, вр)`.trim();
  const html = fill(template, {
    title: escape(snapshot.title),
    thread_title: escape(snapshot.title),
    site_title: escape(config.SITE_TITLE),
    thread_tags: tagsHtml,
    discord_url: `https://discord.com/channels/${escape(config.GUILD_ID)}/${escape(snapshot.threadId)}`,
    discord_button_text: "Открыть в Discord",
    messages: renderedGroups.join("\n"),
    updated_at: escape(DATE_FORMAT.format(new Date())),
    style_href: "../../assets/style.css",
    ...seo(
      snapshot.title,
      description,
      canonical,
      base && firstImage ? new URL(firstImage, base) : undefined,
    ),
  });
  return {
    threadId: snapshot.threadId,
    title: snapshot.title,
    createdAt: snapshot.createdAt,
    excerpt: snapshot.excerpt,
    html,
    assetPaths: assets ? [...assets.paths] : [],
  };
}

function textualEmbeds(message: Message): string {
  return message.embeds
    .flatMap((embed) => [
      embed.author?.name,
      embed.title,
      embed.description,
      ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
      embed.footer?.text,
    ])
    .filter(Boolean)
    .join("\n\n");
}

export async function renderThread(
  thread: ThreadChannel,
  messages: readonly Message[],
  config: RenderConfig,
  storage: RenderAssets,
  isAnswer: (message: Message) => Promise<boolean>,
  signal?: AbortSignal,
  onSnapshot?: (snapshot: ThreadSnapshot) => void,
): Promise<Page & { snapshot: ThreadSnapshot }> {
  const ordered = [...messages].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp,
  );
  if (ordered[0]?.id !== thread.id)
    throw new Error("The thread starter message is missing");
  const profiles = new Map<string, Promise<Profile>>();
  const sources = new Map<string, Source>();
  const archivedMessages: ArchivedMessage[] = [];
  const tags = await loadTags(thread);

  function getProfile(user: User, member?: GuildMember | null) {
    let profile = profiles.get(user.id);
    if (!profile) {
      profile = loadProfile(thread, user, member);
      profiles.set(user.id, profile);
    }
    return profile;
  }

  for (const message of ordered) {
    signal?.throwIfAborted();
    const source = await sourceMessage(message, getProfile);
    sources.set(message.id, source);
    const content = [message.content, textualEmbeds(message)]
      .filter(Boolean)
      .map((text) => source.text(text))
      .join("\n\n");
    const control = new Set([config.PUBLISH_EMOJI, config.ANSWER_EMOJI]);
    const reactions = [...message.reactions.cache.values()]
      .filter(
        ({ emoji, count }) =>
          count > 0 &&
          !control.has(emoji.id ?? "") &&
          !control.has(emoji.name ?? ""),
      )
      .map(({ emoji, count }) => ({
        name: emoji.id ? `:${emoji.name ?? "emoji"}:` : (emoji.name ?? ""),
        count,
      }))
      .filter(({ name }) => Boolean(name));
    archivedMessages.push({
      id: message.id,
      authorId: message.author.id,
      authorName: source.profile.name,
      authorColor: source.profile.color,
      createdAt: message.createdAt.toISOString(),
      content,
      replyTo: message.reference?.messageId ?? null,
      answer: await isAnswer(message),
      reactions,
    });
  }

  const snapshot: ThreadSnapshot = {
    threadId: thread.id,
    title: thread.name,
    createdAt: (thread.createdAt ?? ordered[0]!.createdAt).toISOString(),
    excerpt: sources.get(thread.id)!.excerpt(180),
    tags: tags.map((tag) => tag.name),
    messages: archivedMessages,
  };
  onSnapshot?.(snapshot);
  signal?.throwIfAborted();

  const assets = new ThreadAssets(storage, signal);
  const groups: MessageGroup[] = [];
  let firstImage: string | undefined;
  for (const [index, message] of ordered.entries()) {
    signal?.throwIfAborted();
    const source = sources.get(message.id)!;
    const archived = archivedMessages[index]!;
    const proxies = new Map<string, string>();
    for (const embed of message.embeds) {
      const preview = embed.image ?? embed.thumbnail;
      const url = preview && webUrl(preview.url);
      if (preview && url)
        proxies.set(url.href, preview.proxyURL ?? preview.url);
    }
    const [markdown, media, reactions] = await Promise.all([
      renderMarkdown(
        message.content,
        thread.id,
        assets,
        source.mention,
        proxies,
      ),
      renderMedia(message, assets, proxies),
      renderReactions(message, config, assets),
    ]);
    firstImage ??=
      markdown.images[0] ?? media.find((item) => item.ogImage)?.ogImage;

    const reply = renderReply(
      archived.replyTo ? sources.get(archived.replyTo) : undefined,
    );
    const body = [reply, markdown.html, ...media.map((item) => item.html)]
      .filter(Boolean)
      .join("\n");
    appendMessage(
      groups,
      source,
      renderMessage(message.id, body, archived.answer, reactions),
    );
  }

  const page = await threadPage(
    snapshot,
    config,
    groups,
    await renderTags(thread, tags, assets),
    assets,
    firstImage,
  );
  return { ...page, snapshot };
}

export async function renderArchivedThread(
  snapshot: ThreadSnapshot,
  config: RenderConfig,
): Promise<Page> {
  const sources = new Map<string, DisplaySource>();
  const ordered = [...snapshot.messages].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  for (const message of ordered) {
    sources.set(message.id, {
      id: message.id,
      authorId: message.authorId,
      createdAt: new Date(message.createdAt),
      profile: {
        name: message.authorName,
        color: color(message.authorColor),
        avatar: null,
        roleIcon: null,
      },
      excerpt: (limit) => shortText(message.content, limit),
    });
  }

  const groups: MessageGroup[] = [];
  for (const message of ordered) {
    const source = sources.get(message.id)!;
    const reply = renderReply(
      message.replyTo ? sources.get(message.replyTo) : undefined,
    );
    const markdown = await renderTextMarkdown(message.content);
    const body = [reply, markdown].filter(Boolean).join("\n");
    const badges = message.reactions
      .filter((reaction) => reaction.count > 0)
      .map(
        (reaction) =>
          `<span class="reaction"><span class="emoji">${escape(reaction.name)}</span><em>${reaction.count}</em></span>`,
      )
      .join("");
    const reactions = badges ? `<div class="reactions">${badges}</div>` : "";
    appendMessage(
      groups,
      source,
      renderMessage(message.id, body, message.answer, reactions),
    );
  }
  const tags = snapshot.tags
    .map((tag) => `<span class="tag">${escape(tag)}</span>`)
    .join("");
  return threadPage(
    snapshot,
    config,
    groups,
    tags ? `<div class="tags">${tags}</div>` : "",
  );
}
