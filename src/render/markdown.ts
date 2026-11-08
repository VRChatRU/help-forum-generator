import {
  assetUrl,
  discordMedia,
  mediaFile,
  webUrl,
  type ThreadAssets,
} from "./assets.ts";

const escape = Bun.escapeHTML;
const ENCODED = /&(?:amp|lt|gt|quot|apos|#x27|#39);/gi;
const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#x27;": "'",
  "&#39;": "'",
};

function decodeHtml(value: string): string {
  return value.replace(
    ENCODED,
    (entity) => ENTITIES[entity.toLowerCase()] ?? entity,
  );
}

export function shortText(source: string, limit: number): string {
  const text = source
    .replace(/`{3,}[\s\S]*?`{3,}/g, " ")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/(?:^|\n)\s*(?:[#>]+|[*+-](?=\s))/g, " ")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const characters = [...text];
  return characters.length > limit
    ? characters
        .slice(0, limit - 1)
        .join("")
        .trimEnd() + "…"
    : text;
}

async function replaceAsync(
  value: string,
  pattern: RegExp,
  replace: (match: RegExpMatchArray) => string | Promise<string>,
): Promise<string> {
  const parts: Array<string | Promise<string>> = [];
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index!;
    parts.push(value.slice(offset, start), replace(match));
    offset = start + match[0].length;
  }
  parts.push(value.slice(offset));
  return (await Promise.all(parts)).join("");
}

export function image(
  source: string,
  alt = "",
  icon?: "inline-emoji" | "reaction" | "tag",
): string {
  const size = icon === "inline-emoji" ? 30 : 16;
  return `<img src="${escape(source)}" alt="${escape(alt)}"${
    icon
      ? ` class="${icon === "inline-emoji" ? icon : "emoji"}" width="${size}" height="${size}"`
      : ""
  } loading="lazy" decoding="async">`;
}

export function externalLink(
  href: string,
  html: string,
  attributes = "",
): string {
  return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer"${attributes}>${html}</a>`;
}

export async function customEmoji(
  id: string,
  name: string,
  animated: boolean,
  assets: ThreadAssets,
  icon: "inline-emoji" | "reaction" | "tag",
): Promise<string> {
  const ext = animated ? "gif" : "png";
  const source = `https://cdn.discordapp.com/emojis/${id}.${ext}`;
  const path = await assets.localize(
    source,
    icon === "tag" ? "tags" : "emojis",
    ext,
  );
  return path ? image(assetUrl(path), name, icon) : escape(name);
}

export async function archiveImage(
  source: string,
  proxy: string | undefined,
  assets: ThreadAssets,
  threadId: string,
): Promise<{ src: string; ogImage: string } | null> {
  const remote = webUrl(source);
  const trusted = (proxy && discordMedia(proxy)) || discordMedia(source);
  const extension = mediaFile(trusted ? trusted.href : source);
  const local =
    trusted &&
    (await assets.localize(
      trusted.href,
      threadId,
      extension.kind === "image" ? extension.extension : "webp",
    ));
  if (local) return { src: assetUrl(local), ogImage: local };
  return remote ? { src: remote.href, ogImage: remote.href } : null;
}

type Mention = (syntax: string) => string;

function normalizeCodeBlocks(source: string): string {
  source = source.replace(/\r\n?/g, "\n");
  const parts: string[] = [];
  const runs = /`+|~{3,}/g;
  let offset = 0;
  let fence: { marker: string; length: number; prefix: string } | undefined;

  for (let match = runs.exec(source); match; match = runs.exec(source)) {
    const start = match.index;
    const end = runs.lastIndex;
    const run = match[0];
    const marker = run[0]!;
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = source.indexOf("\n", end);
    const prefix = source.slice(lineStart, start);
    const suffix = source.slice(end, lineEnd < 0 ? source.length : lineEnd);
    const container =
      /^(?:[ \t]{0,3}>[ \t]?)*[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?/.exec(
        prefix,
      )![0];
    const atLineStart = container === prefix;
    const continuation = container.replace(
      /(?:[-+*]|\d{1,9}[.)])[ \t]+$/,
      (marker) => " ".repeat(marker.length),
    );

    if (fence) {
      if (marker !== fence.marker || run.length < fence.length) continue;
      if (marker === "~" || fence.length > 3) {
        if (atLineStart && /^[ \t]*$/.test(suffix)) fence = undefined;
        continue;
      }
      parts.push(
        source.slice(offset, start),
        atLineStart ? "" : "\n" + fence.prefix,
        run,
      );
      if (!/^[ \t]*$/.test(suffix)) parts.push("\n" + fence.prefix);
      offset = end;
      fence = undefined;
      continue;
    }

    let slashes = 0;
    for (let index = start - 1; source[index] === "\\"; index--) slashes++;
    if (slashes % 2) continue;

    if (marker === "~") {
      if (atLineStart)
        fence = { marker, length: run.length, prefix: continuation };
      continue;
    }
    if (run.length < 3) {
      // Inline code can contain triple backticks as literal text.
      const closing = new RegExp("(?<!`)" + run + "(?!`)", "g");
      closing.lastIndex = end;
      const next = closing.exec(source);
      if (next && !/\n[ \t]*\n/.test(source.slice(end, next.index)))
        runs.lastIndex = next.index + next[0].length;
      continue;
    }

    // Discord accepts inline fences; Bun requires delimiters on their own lines.
    parts.push(
      source.slice(offset, start),
      atLineStart ? "" : "\n" + continuation,
      run,
    );
    const info = suffix.trim();
    if (info && !/^[a-z0-9_][a-z0-9_+.#/-]*$/i.test(info))
      parts.push("\n" + continuation);
    offset = end;
    fence = { marker, length: run.length, prefix: continuation };
  }
  parts.push(source.slice(offset));
  return parts.join("");
}

export async function renderMarkdown(
  source: string,
  threadId: string,
  assets: ThreadAssets | null,
  mention: Mention,
  proxyBySource: ReadonlyMap<string, string>,
): Promise<{ html: string; images: string[] }> {
  const html = Bun.markdown.html(normalizeCodeBlocks(source), {
    noHtmlBlocks: true,
    noHtmlSpans: true,
    autolinks: { url: true, www: true },
    underline: true,
  });
  const images: Array<string | undefined> = [];

  async function renderImage(href: string, alt: string, link: boolean) {
    if (!assets) return escape(alt);
    const index = images.push(undefined) - 1;
    const media = await archiveImage(
      href,
      proxyBySource.get(href),
      assets,
      threadId,
    );
    if (!media) return escape(alt);
    images[index] = media.ogImage;
    const tag = image(media.src, alt);
    return link ? externalLink(media.src, tag) : tag;
  }

  async function renderText(text: string, link = true) {
    return replaceAsync(
      text,
      /&lt;(?:@!?[0-9]+|@&amp;[0-9]+|#[0-9]+|(a?):([a-z0-9_]+):([0-9]+)|https?:\/\/[^\s<>]*?)&gt;/gi,
      (match) => {
        const [encoded, animated, name, emojiId] = match;
        if (emojiId && name) {
          return assets
            ? customEmoji(
                emojiId,
                `:${name}:`,
                Boolean(animated),
                assets,
                "inline-emoji",
              )
            : escape(`:${name}:`);
        }
        const value = decodeHtml(encoded).slice(1, -1);
        if (!link || !/^https?:\/\//i.test(value)) return mention(value);
        const url = webUrl(value);
        return url ? externalLink(url.href, escape(value)) : encoded;
      },
    );
  }

  function renderFragment(fragment: string, link = true): Promise<string> {
    // Bun emits escaped HTML. Leave code and tag attributes out of Discord token handling.
    return replaceAsync(
      fragment,
      /<code(?: [^>]*)?>[\s\S]*?<\/code>|<a href="([^"]*)"( title="[^"]*")?>([\s\S]*?)<\/a>|<img src="([^"]*)" alt="([^"]*)"[^>]*>|<[^>]+>|[^<]+/g,
      async ([token, href, title, body, src, alt]) => {
        if (src !== undefined)
          return renderImage(decodeHtml(src), decodeHtml(alt ?? ""), link);
        if (href !== undefined && body !== undefined) {
          const value = decodeHtml(href);
          const url = webUrl(value);
          if (assets && url && body === href && /\.gif$/i.test(url.pathname)) {
            return renderImage(url.href, "", true);
          }
          const label = await renderFragment(body, false);
          if (url) return externalLink(url.href, label, title);
          const relative = !/^(?:\/\/|[^/?#]*:)/.test(value);
          const mailto = /^mailto:[^@\s]+@[^@\s]+$/i.test(value);
          if ((relative || mailto) && !/[\u0000-\u0020\\]/.test(value)) {
            return `<a href="${escape(value)}"${title ?? ""}>${label}</a>`;
          }
          return label;
        }
        return token.startsWith("<") ? token : renderText(token, link);
      },
    );
  }

  return {
    html: await renderFragment(html),
    images: images.filter((url): url is string => url !== undefined),
  };
}

export async function renderTextMarkdown(source: string): Promise<string> {
  const rendered = await renderMarkdown(
    source,
    "",
    null,
    (syntax) => escape(`<${syntax}>`),
    new Map(),
  );
  return rendered.html;
}
