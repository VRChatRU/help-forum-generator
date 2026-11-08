import type { ArchivedMessage, PageMeta, ThreadSnapshot } from "./model";

type HtmlNode = {
  tag: string;
  attributes: Record<string, string>;
  children: Array<HtmlNode | string>;
};

const voidTags = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const excludedTags = new Set([
  "script",
  "style",
  "video",
  "audio",
  "source",
  "iframe",
  "picture",
  "object",
  "embed",
]);
const blockTags = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "tr",
  "table",
]);
const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decode(value: string): string {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (match, entity: string) => {
      if (!entity.startsWith("#"))
        return entities[entity.toLowerCase()] ?? match;
      const point =
        entity[1]?.toLowerCase() === "x"
          ? parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return point > 0 &&
        point <= 0x10ffff &&
        !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : "�";
    },
  );
}

function parse(html: string): HtmlNode {
  const root: HtmlNode = { tag: "root", attributes: {}, children: [] };
  let current = root;
  new HTMLRewriter()
    .on("*", {
      element(element) {
        const attributes: Record<string, string> = {};
        for (const [key, value] of element.attributes)
          attributes[key] = decode(value);
        const node: HtmlNode = {
          tag: element.tagName,
          attributes,
          children: [],
        };
        current.children.push(node);
        if (voidTags.has(node.tag)) return;
        const parent = current;
        current = node;
        element.onEndTag(() => {
          current = parent;
        });
      },
      text(text) {
        current.children.push(decode(text.text));
      },
    })
    .transform(html);
  return root;
}

function* descendants(node: HtmlNode): Generator<HtmlNode> {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    yield child;
    yield* descendants(child);
  }
}

function hasClass(node: HtmlNode, name: string): boolean {
  return (node.attributes.class ?? "").split(/\s+/).includes(name);
}

function text(node: HtmlNode, emoji = false): string {
  if (node.tag === "img") return emoji ? (node.attributes.alt ?? "") : "";
  return node.children
    .map((child) => (typeof child === "string" ? child : text(child, emoji)))
    .join("");
}

function isMediaLink(node: HtmlNode): boolean {
  const href = node.attributes.href ?? "";
  if (
    "download" in node.attributes ||
    /^(?:\.\.\/\.\.\/|\/)assets\//.test(href)
  )
    return true;
  const url = URL.parse(href);
  return Boolean(
    url &&
    (/^(?:cdn\.discordapp\.com|media\.discordapp\.net|images-ext-\d+\.discordapp\.net)$/.test(
      url.hostname,
    ) ||
      /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|mov|m4v|mp3|m4a|wav|ogg|aac|flac|zip|rar|7z|pdf)$/i.test(
        url.pathname,
      )),
  );
}

function body(node: HtmlNode, inCode = false): string {
  if (
    excludedTags.has(node.tag) ||
    hasClass(node, "reply") ||
    hasClass(node, "attachment")
  )
    return "";
  if (node.tag === "img")
    return hasClass(node, "inline-emoji") || hasClass(node, "emoji")
      ? (node.attributes.alt ?? "")
      : "";
  if (node.tag === "br" || node.tag === "hr") return "\n";
  if (node.tag === "a" && isMediaLink(node)) return "";
  if (node.tag === "pre") {
    const code = node.children
      .map((child) => (typeof child === "string" ? child : body(child, true)))
      .join("");
    return `\n\`\`\`\n${code}${code.endsWith("\n") ? "" : "\n"}\`\`\`\n`;
  }
  const preserveSpace = inCode || node.tag === "code";
  const content = node.children
    .map((child) =>
      typeof child === "string"
        ? preserveSpace
          ? child
          : child.replace(/\s+/g, " ")
        : body(child, preserveSpace),
    )
    .join("");
  if (node.tag === "a") {
    const href = node.attributes.href ?? "";
    const url = URL.parse(href);
    const caption = content.trim();
    return caption &&
      url &&
      ["http:", "https:"].includes(url.protocol) &&
      caption !== href
      ? `${caption} (${href})`
      : content;
  }
  if (node.tag === "code" && !inCode) return `\`${content}\``;
  if (node.tag === "strong" || node.tag === "b") return `**${content}**`;
  if (node.tag === "em" || node.tag === "i") return `*${content}*`;
  if (node.tag === "del" || node.tag === "s") return `~~${content}~~`;
  if (node.tag === "li") return `\n- ${content.trim()}`;
  if (node.tag === "td" || node.tag === "th") return `${content.trim()} | `;
  if (node.tag === "blockquote")
    return `\n> ${content.trim().replace(/\n/g, "\n> ")}\n`;
  if (/^h[1-6]$/.test(node.tag))
    return `\n${"#".repeat(Number(node.tag[1]))} ${content.trim()}\n`;
  return blockTags.has(node.tag) ? `\n${content.trim()}\n` : content;
}

function messageDate(id: string, fallback: string): string {
  if (!/^\d{1,20}$/.test(id)) return fallback;
  return new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString();
}

export function legacySnapshot(meta: PageMeta, html: string): ThreadSnapshot {
  const root = parse(html);
  const nodes = [...descendants(root)];
  const tags = nodes
    .filter((node) => hasClass(node, "tag"))
    .map((node) => text(node).trim())
    .filter(Boolean);
  const messages: ArchivedMessage[] = [];

  for (const group of nodes.filter((node) => hasClass(node, "group"))) {
    const children = [...descendants(group)];
    const author = children.find((node) => node.tag === "h3");
    const authorName = author ? text(author).trim() : "Unknown";
    const authorColor =
      /(?:^|;)\s*color\s*:\s*(#[\da-f]{6})(?:\s|;|$)/i.exec(
        author?.attributes.style ?? "",
      )?.[1] ?? "#8b949e";
    const avatar = children.find(
      (node) =>
        node.tag === "img" &&
        /(?:^|\/)avatars\//.test(node.attributes.src ?? ""),
    );
    const authorId =
      /avatar-(\d+)\./.exec(avatar?.attributes.src ?? "")?.[1] ?? "";
    const date =
      children.find((node) => node.tag === "time")?.attributes.datetime ??
      meta.createdAt;

    for (const message of children.filter((node) =>
      hasClass(node, "message"),
    )) {
      const id = /^m-(\d{1,20})$/.exec(message.attributes.id ?? "")?.[1];
      if (!id)
        throw new Error(`Invalid message in legacy thread ${meta.threadId}`);
      const parts = [...descendants(message)];
      const content = parts.find((node) => hasClass(node, "body"));
      if (!content)
        throw new Error(
          `Missing message body in legacy thread ${meta.threadId}`,
        );
      const reply = parts.find((node) => hasClass(node, "reply"));
      const target =
        reply &&
        [...descendants(reply)].find(
          (node) =>
            node.tag === "a" && /^#m-\d+$/.test(node.attributes.href ?? ""),
        );
      const reactions = parts
        .filter((node) => hasClass(node, "reaction"))
        .map((node) => {
          const inner = [...descendants(node)];
          const count = inner.find((child) => child.tag === "em");
          const icon = inner.find(
            (child) => child.tag === "img" || hasClass(child, "emoji"),
          );
          return {
            name: icon ? text(icon, true).trim() : "",
            count: Number(count ? text(count) : 0),
          };
        })
        .filter(
          (reaction) =>
            reaction.name &&
            Number.isSafeInteger(reaction.count) &&
            reaction.count > 0,
        );
      messages.push({
        id,
        authorId,
        authorName,
        authorColor,
        createdAt: messageDate(id, date),
        content: body(content).trim(),
        replyTo: target?.attributes.href?.slice(3) ?? null,
        answer: message.attributes["data-answer"] === "true",
        reactions,
      });
    }
  }

  if (!messages.length)
    throw new Error(`No messages found in legacy thread ${meta.threadId}`);
  return {
    threadId: meta.threadId,
    title: meta.title,
    createdAt: meta.createdAt,
    excerpt: meta.excerpt,
    tags,
    messages,
  };
}
