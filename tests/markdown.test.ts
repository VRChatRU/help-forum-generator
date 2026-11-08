import { expect, test } from "bun:test";
import { renderTextMarkdown } from "../src/render/markdown.ts";

type CodeBlock = { text: string; language: string | null };

function textValue(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    "#39": "'",
    "#x27": "'",
  };
  return value.replace(
    /&(amp|lt|gt|quot|apos|#39|#x27);/gi,
    (entity, name: string) => entities[name.toLowerCase()] ?? entity,
  );
}

async function rendered(source: string) {
  const html = await renderTextMarkdown(source);
  const blocks: CodeBlock[] = [];
  const paragraphs: string[] = [];
  const inline: string[] = [];
  new HTMLRewriter()
    .on("pre > code", {
      element(element) {
        blocks.push({ text: "", language: element.getAttribute("class") });
      },
      text(text) {
        blocks.at(-1)!.text += textValue(text.text);
      },
    })
    .on("p", {
      element() {
        paragraphs.push("");
      },
      text(text) {
        paragraphs[paragraphs.length - 1] += textValue(text.text);
      },
    })
    .on("p code", {
      element() {
        inline.push("");
      },
      text(text) {
        inline[inline.length - 1] += textValue(text.text);
      },
    })
    .transform(html);
  return { blocks, paragraphs, inline };
}

const fence = "```";

test("ends the archived cache example at its inline closing fence", async () => {
  const result = await rendered(
    fence +
      '{\n    "cache_directory" : "C:/VRCCache/"\n}' +
      fence +
      "\nЕсли будут вопросы - задавайте их здесь",
  );
  expect(result.blocks).toHaveLength(1);
  expect(result.blocks[0]!.text.trimEnd()).toBe(
    '{\n    "cache_directory" : "C:/VRCCache/"\n}',
  );
  expect(result.blocks[0]!.language).toBeNull();
  expect(result.paragraphs).toContain(
    "Если будут вопросы - задавайте их здесь",
  );
});

test("uses inline backtick fences for generic code with surrounding prose", async () => {
  const result = await rendered("Before " + fence + "body" + fence + " After");
  expect(result.blocks).toHaveLength(1);
  expect(result.blocks[0]!.text.trimEnd()).toBe("body");
  expect(result.paragraphs.map((paragraph) => paragraph.trim())).toEqual([
    "Before",
    "After",
  ]);
});

test("keeps language tags when an inline fence closes a code block", async () => {
  const result = await rendered(
    fence + 'json\n{\n  "x": 1\n}' + fence + "\nAfter",
  );
  expect(result.blocks).toHaveLength(1);
  expect(result.blocks[0]!.text.trimEnd()).toBe('{\n  "x": 1\n}');
  expect(result.blocks[0]!.language).toBe("language-json");
  expect(result.paragraphs).toEqual(["After"]);
});

test("preserves ordinary fenced code and handles CRLF line endings", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const result = await rendered(
      fence + "json" + newline + "{}" + newline + fence + newline + "After",
    );
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.text.trimEnd()).toBe("{}");
    expect(result.blocks[0]!.language).toBe("language-json");
    expect(result.paragraphs).toEqual(["After"]);
  }
  const inlineClose = await rendered(
    fence + 'json\r\n{"x": 1}' + fence + "\r\nAfter",
  );
  expect(inlineClose.blocks[0]!.text.trimEnd()).toBe('{"x": 1}');
  expect(inlineClose.paragraphs).toEqual(["After"]);
});

test("keeps adjacent code blocks separate", async () => {
  const result = await rendered(
    fence + "first" + fence + "\n" + fence + "second" + fence,
  );
  expect(result.blocks.map((block) => block.text.trimEnd())).toEqual([
    "first",
    "second",
  ]);
  expect(result.paragraphs).toEqual([]);
});

test("preserves triple backticks inside single and double inline code spans", async () => {
  for (const delimiter of ["`", "``"]) {
    const result = await rendered(
      "Before " +
        delimiter +
        "literal " +
        fence +
        " token" +
        delimiter +
        " after",
    );
    expect(result.blocks).toEqual([]);
    expect(result.inline).toEqual(["literal " + fence + " token"]);
  }
});

test("preserves shorter backtick runs inside longer fenced code", async () => {
  const longFence = "````";
  const result = await rendered(
    longFence +
      "text\nA literal " +
      fence +
      " inside\n" +
      longFence +
      "\nAfter",
  );
  expect(result.blocks).toHaveLength(1);
  expect(result.blocks[0]!.text.trimEnd()).toBe(
    "A literal " + fence + " inside",
  );
  expect(result.blocks[0]!.language).toBe("language-text");
  expect(result.paragraphs).toEqual(["After"]);
});

test("leaves triple backticks literal inside a tilde code block", async () => {
  const result = await rendered(
    "~~~text\nA literal " + fence + " inside\n~~~\nAfter",
  );
  expect(result.blocks).toHaveLength(1);
  expect(result.blocks[0]!.text.trimEnd()).toBe(
    "A literal " + fence + " inside",
  );
  expect(result.blocks[0]!.language).toBe("language-text");
  expect(result.paragraphs).toEqual(["After"]);
});

test("requires a closing line for longer backtick fences", async () => {
  const delimiter = "````";
  const content = "contains " + delimiter + " literal\nnext";
  const result = await rendered(
    delimiter + "text\n" + content + "\n" + delimiter + "\nAfter",
  );
  expect(result.blocks).toHaveLength(1);
  expect(result.blocks[0]!.text.trimEnd()).toBe(content);
  expect(result.paragraphs).toEqual(["After"]);
});

test("leaves escaped triple backticks as text", async () => {
  const result = await rendered(
    "Before \\" + fence + "body\\" + fence + " after",
  );
  expect(result.blocks).toEqual([]);
  expect(result.inline).toEqual([]);
  expect(result.paragraphs).toEqual([
    "Before " + fence + "body" + fence + " after",
  ]);
});

test("keeps code fences inside blockquotes and lists", async () => {
  for (const source of [
    "> " + fence + "json\n> {}\n> " + fence + "\n\nAfter",
    "- " + fence + "json\n  {}\n  " + fence + "\n\nAfter",
    "> " + fence + "{\n> }" + fence + "\n\nAfter",
  ]) {
    const result = await rendered(source);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.text.trimEnd()).toBe(
      source.includes("\n> }") ? "{\n}" : "{}",
    );
    expect(result.paragraphs).toContain("After");
  }
});
