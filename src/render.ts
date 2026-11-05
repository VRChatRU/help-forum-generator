import {
  ChannelType,
  type GuildMember,
  type Message,
  type ThreadChannel,
  type User,
} from "discord.js";
import type { Page, PageMeta } from "./archive.ts";
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
  avatar: string;
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
const TEMPLATES = new URL(
  "../help-forum-generator-data/templates/",
  import.meta.url,
);
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

type Source = {
  message: Message;
  profile: Profile;
  mention(syntax: string): string;
  excerpt(limit: number): string;
};

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

  return {
    message,
    profile,
    mention(syntax) {
      const value = display(syntax);
      return `<span class="mention" style="color: ${value.color}">${escape(value.name)}</span>`;
    },
    excerpt(limit) {
      return shortText(
        message.content.replace(
          /<(@!?[0-9]+|@&[0-9]+|#[0-9]+)>/g,
          (_, syntax: string) => display(syntax).name,
        ),
        limit,
      );
    },
  };
}

async function renderTags(
  thread: ThreadChannel,
  assets: ThreadAssets,
): Promise<string> {
  if (!thread.appliedTags.length || !thread.parentId) return "";
  const parent =
    thread.parent ?? (await thread.guild.channels.fetch(thread.parentId));
  if (
    parent?.type !== ChannelType.GuildForum &&
    parent?.type !== ChannelType.GuildMedia
  )
    return "";

  const byId = new Map(parent.availableTags.map((tag) => [tag.id, tag]));
  const tags = await Promise.all(
    thread.appliedTags.map(async (id) => {
      const tag = byId.get(id);
      if (!tag) return "";
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
  return tags.some(Boolean) ? `<div class="tags">${tags.join("")}</div>` : "";
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

function renderReply(source: Source | undefined): string {
  if (!source) return "";
  const text = source.excerpt(80);
  return `<div class="reply">
  <span>Ответ на <a href="#m-${escape(source.message.id)}" style="color: ${source.profile.color}">${escape(source.profile.name)}</a></span>
  ${text ? `<p>${escape(text)}</p>` : ""}
</div>`;
}

async function renderGroup(
  source: Source,
  messages: string[],
  assets: ThreadAssets,
): Promise<string> {
  const { message, profile } = source;
  const [avatar, role] = await Promise.all([
    assets.localize(profile.avatar, "avatars", "png"),
    profile.roleIcon && assets.localize(profile.roleIcon, "roles", "png"),
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
      <time datetime="${message.createdAt.toISOString()}">${escape(DATE_FORMAT.format(message.createdAt))}</time>
    </div>
  </header>
  <section>
${messages.join("\n")}
  </section>
</article>`;
}

export async function renderThread(
  thread: ThreadChannel,
  messages: readonly Message[],
  config: RenderConfig,
  storage: RenderAssets,
  isAnswer: (message: Message) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<Page> {
  const ordered = [...messages].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp,
  );
  if (ordered[0]?.id !== thread.id)
    throw new Error("The thread starter message is missing");
  const [, template] = await templates();
  const assets = new ThreadAssets(storage, signal);
  const profiles = new Map<string, Promise<Profile>>();
  const sources = new Map<string, Source>();
  const groups: Array<{ source: Source; last: number; messages: string[] }> =
    [];
  const answerIds: string[] = [];
  let firstImage: string | undefined;

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
    const proxies = new Map<string, string>();
    for (const embed of message.embeds) {
      const preview = embed.image ?? embed.thumbnail;
      const url = preview && webUrl(preview.url);
      if (preview && url)
        proxies.set(url.href, preview.proxyURL ?? preview.url);
    }
    const [markdown, media, reactions, answer] = await Promise.all([
      renderMarkdown(
        message.content,
        thread.id,
        assets,
        source.mention,
        proxies,
      ),
      renderMedia(message, assets, proxies),
      renderReactions(message, config, assets),
      isAnswer(message),
    ]);
    firstImage ??=
      markdown.images[0] ?? media.find((item) => item.ogImage)?.ogImage;
    if (answer) answerIds.push(message.id);

    const reference = message.reference?.messageId;
    const reply = renderReply(reference ? sources.get(reference) : undefined);
    const body = [reply, markdown.html, ...media.map((item) => item.html)]
      .filter(Boolean)
      .join("\n");
    const html = `<div id="m-${escape(message.id)}" class="message" data-answer="${answer}">
  <div class="meta">${answer ? '<span class="badge">Ответ</span>' : ""}</div>
  <div class="body">${body}</div>
  ${reactions}
</div>`;
    const group = groups.at(-1);
    if (
      group?.source.message.author.id === message.author.id &&
      message.createdTimestamp - group.last <= GROUP_INTERVAL
    ) {
      group.messages.push(html);
      group.last = message.createdTimestamp;
    } else {
      groups.push({ source, last: message.createdTimestamp, messages: [html] });
    }
  }

  const renderedGroups: string[] = [];
  for (const group of groups) {
    signal?.throwIfAborted();
    renderedGroups.push(
      await renderGroup(group.source, group.messages, assets),
    );
  }
  if (answerIds.length) {
    const links = answerIds.map(
      (id, index) => `<a href="#m-${escape(id)}">Ответ ${index + 1}</a>`,
    );
    renderedGroups.splice(
      1,
      0,
      `<nav class="answers-nav"><span>Ответы:</span>${links.join("")}</nav>`,
    );
  }

  const excerpt = sources.get(thread.id)!.excerpt(180);
  const createdAt = (thread.createdAt ?? ordered[0]!.createdAt).toISOString();
  const base = baseUrl(config);
  const canonical = base && new URL(`threads/${thread.id}/`, base);
  const description = `${excerpt} (VRChat, врчат, вр чат, vr, вр)`.trim();
  const html = fill(template, {
    title: escape(thread.name),
    thread_title: escape(thread.name),
    site_title: escape(config.SITE_TITLE),
    thread_tags: await renderTags(thread, assets),
    discord_url: escape(thread.url),
    discord_button_text: "Открыть в Discord",
    messages: renderedGroups.join("\n"),
    updated_at: escape(DATE_FORMAT.format(new Date())),
    style_href: "../../assets/style.css",
    ...seo(
      thread.name,
      description,
      canonical,
      base && firstImage ? new URL(firstImage, base) : undefined,
    ),
  });
  return {
    threadId: thread.id,
    title: thread.name,
    createdAt,
    excerpt,
    html,
    assetPaths: [...assets.paths],
  };
}
