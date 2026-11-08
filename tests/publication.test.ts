import { expect, test } from "bun:test";
import { resolve } from "node:path";

const project = resolve(import.meta.dir, "..");

// Bun module mocks are process-wide. Keep the production lifecycle and its
// dependency substitutes in a subprocess so other tests use the real modules.
const harness = String.raw`
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ChannelType, Events, GatewayDispatchEvents } from "discord.js";
import { Archive } from "./src/archive.ts";

const scenario = process.env.PUBLICATION_SCENARIO;
const config = {
  GUILD_ID: "100000000000000001",
  FORUM_CHANNEL_ID: "100000000000000002",
  LOG_CHANNEL_ID: "100000000000000003",
  PUBLISHER_ROLE_IDS: ["100000000000000004"],
  BOT_TOKEN: "test-token",
  PUBLISH_EMOJI: "🌐",
  ANSWER_EMOJI: "✅",
  SITE_TITLE: "Test forum",
  SITE_DESCRIPTION: "Test description",
  BASE_URL: "https://help.example/",
};
const threadId = "100000000000000005";
const actorId = "100000000000000006";
const snapshot = {
  threadId,
  title: "Preserved question",
  createdAt: "2026-01-01T00:00:00.000Z",
  excerpt: "Preserved question text",
  tags: ["Help"],
  messages: [{
    id: threadId,
    authorId: actorId,
    authorName: "Question author",
    authorColor: "#123456",
    createdAt: "2026-01-01T00:00:00.000Z",
    content: "Preserved question text",
    replyTo: null,
    answer: false,
    reactions: [],
  }],
};
const livePage = {
  threadId,
  title: snapshot.title,
  createdAt: snapshot.createdAt,
  excerpt: snapshot.excerpt,
  html: '<p>Live question text</p><img src="../../assets/question.png">',
  assetPaths: ["assets/question.png"],
};
const archive = new Archive(":memory:");
if (scenario !== "startup" && scenario !== "deletion-race") archive.save(snapshot);

const logs = [];
const log = Object.fromEntries(["info", "warn", "error"].map((level) => [
  level,
  (message, fields) => logs.push({ level, message, fields }),
]));
const notices = [];
let startupAttempts = 0;
let directMessages = 0;
const client = new EventEmitter();
client.ws = new EventEmitter();
client.channels = {
  cache: new Map(),
  async fetch(id) {
    if (id === config.FORUM_CHANNEL_ID) {
      return { id, guildId: config.GUILD_ID, type: ChannelType.GuildForum };
    }
    assert.equal(id, config.LOG_CHANNEL_ID);
    return {
      isSendable: () => true,
      async send(message) {
        if (message.content === "vrcru-help-forum-generator перезагружен") {
          startupAttempts++;
          if (scenario === "startup" && startupAttempts === 1) {
            throw new Error("Temporary notification outage");
          }
        }
        notices.push(message);
      },
    };
  },
};
client.users = { async send() { directMessages++; } };
client.login = async () => { client.emit(Events.ClientReady); return "test-token"; };
client.destroy = async () => {};

const thread = {
  id: threadId,
  guildId: config.GUILD_ID,
  parentId: config.FORUM_CHANNEL_ID,
  name: snapshot.title,
  url: "https://discord.com/channels/" + config.GUILD_ID + "/" + threadId,
  client,
};
let sourceState = scenario === "missing-thread" ? "missing-thread" : "published";
if (scenario === "starter-checks") sourceState = "transient";
let incompleteChecks = 0;
let deniedChecks = 0;
const renderStarted = Promise.withResolvers();
const releaseRender = Promise.withResolvers();
const actualRender = await import("./src/render.ts");
const renderArchivedThread = actualRender.renderArchivedThread;

mock.module("./src/discord.ts", () => ({
  createDiscord: () => client,
  async fetchForumThread() {
    if (sourceState === "denied") {
      deniedChecks++;
      throw Object.assign(new Error("Missing Access"), { code: 50001, status: 403 });
    }
    return sourceState === "missing-thread" ? null : thread;
  },
  async fetchThreadMessages() { return sourceState === "incomplete" ? [] : [{ id: threadId }]; },
  async inspectThread() {
    if (sourceState === "transient") throw new Error("Temporary Discord outage");
    if (sourceState === "missing-starter") return { status: "missing" };
    if (sourceState === "incomplete") incompleteChecks++;
    return { status: "published" };
  },
  isAnswerMessage: async () => false,
  isForumThread: () => true,
  isPublisher: async () => true,
  listForumThreads: async () => [],
  matchesEmoji: (emoji, expected) => emoji.name === expected,
}));
mock.module("./src/render.ts", () => ({
  renderArchivedThread,
  renderSite: async () => ({ index: "Site index", css: "" }),
  async renderThread(_thread, _messages, _config, _storage, _answer, _signal, onSnapshot) {
    onSnapshot(snapshot);
    renderStarted.resolve();
    if (scenario === "deletion-race") await releaseRender.promise;
    return livePage;
  },
}));

const { runPublication } = await import("./src/publication.ts");
const writes = [];
let siteWrites = 0;
let currentPage = livePage;
const output = {
  async writePage(page) { currentPage = page; writes.push(page); },
  async removePage() { throw new Error("Unexpected unpublication"); },
  async writeSite() { siteWrites++; },
  async hasAsset() { return false; },
  async writeAsset() {},
};
const stop = new AbortController();
const running = runPublication(config, archive, output, log, undefined, stop.signal);

async function until(predicate, description) {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for " + description + ": " + JSON.stringify(logs));
    }
    await Bun.sleep(2);
  }
}

function assertTextFallback() {
  assert.equal(archive.get(threadId).sourceMissing, true);
  assert.equal(archive.get(threadId).published, true);
  assert.equal(archive.get(threadId).messages[0].content, snapshot.messages[0].content);
  assert.match(currentPage.html, /Preserved question text/);
  assert.doesNotMatch(currentPage.html, /<(?:audio|video|iframe|source)\b/i);
  assert.doesNotMatch(currentPage.html, /src="\.\.\/\.\.\/assets\//);
  assert.deepEqual(currentPage.assetPaths, []);
}

try {
  if (scenario === "startup") {
    await until(() => startupAttempts === 1 && logs.some((entry) => entry.level === "warn"), "failed startup notice");
    client.emit(Events.ShardReconnecting);
    client.emit(Events.ShardResume);
    await until(() => notices.length === 1, "retried startup notice");
    client.emit(Events.ClientReady);
    client.emit(Events.ShardResume);
    await until(() => logs.filter((entry) => entry.message === "Ready to process forum reactions").length === 2, "reconnected setup");
    assert.equal(startupAttempts, 2);
    assert.deepEqual(notices.map((message) => message.content), ["vrcru-help-forum-generator перезагружен"]);
    assert.deepEqual(notices[0].allowedMentions, { parse: [] });
    assert.equal(directMessages, 0);
  } else if (scenario === "missing-thread") {
    await until(() => siteWrites > 0, "deleted topic fallback");
    assertTextFallback();
  } else if (scenario === "starter-checks") {
    await until(() => logs.some((entry) => entry.message === "Job failed and will be retried"), "transient source failure");
    assert.equal(archive.get(threadId).sourceMissing, false);
    assert.equal(writes.length, 0);
    assert.equal(currentPage, livePage);

    sourceState = "denied";
    client.emit(Events.ShardResume);
    await until(() => deniedChecks > 0, "temporary loss of source access");
    assert.equal(archive.get(threadId).sourceMissing, false);
    assert.equal(writes.length, 0);

    sourceState = "incomplete";
    client.emit(Events.ShardResume);
    await until(() => incompleteChecks >= 2, "history check and starter confirmation");
    assert.equal(archive.get(threadId).sourceMissing, false);
    assert.equal(archive.get(threadId).messages[0].content, snapshot.messages[0].content);
    assert.equal(writes.length, 0);

    sourceState = "missing-starter";
    client.emit(Events.ShardResume);
    await until(() => siteWrites > 0, "confirmed starter deletion");
    assertTextFallback();
  } else if (scenario === "deletion-race") {
    await until(() => notices.length === 1, "startup notice");
    client.ws.emit(GatewayDispatchEvents.MessageReactionAdd, {
      guild_id: config.GUILD_ID,
      channel_id: threadId,
      message_id: threadId,
      user_id: actorId,
      emoji: { id: null, name: config.PUBLISH_EMOJI },
    });
    await renderStarted.promise;
    assert.equal(archive.get(threadId).messages[0].content, snapshot.messages[0].content);
    client.ws.emit(GatewayDispatchEvents.ThreadDelete, {
      id: threadId,
      guild_id: config.GUILD_ID,
      parent_id: config.FORUM_CHANNEL_ID,
      type: ChannelType.PublicThread,
    });
    client.emit(Events.ShardReconnecting);
    releaseRender.resolve();
    await until(() => archive.get(threadId)?.sourceMissing && currentPage.assetPaths.length === 0 && siteWrites > 0, "deletion after pending rendering");
    assertTextFallback();
  } else {
    throw new Error("Unknown publication scenario " + scenario);
  }
} finally {
  releaseRender.resolve();
  stop.abort();
  await running;
  archive.close();
}
`;

async function verifyScenario(scenario: string): Promise<void> {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "--eval", harness],
    {
      cwd: project,
      env: {
        PUBLICATION_SCENARIO: scenario,
        SystemRoot: Bun.env.SystemRoot ?? "",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 7_000,
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exitCode, output: `${stdout}${stderr}` }).toEqual({
    exitCode: 0,
    output: "",
  });
}

test("retries the exact startup notice and keeps it once across reconnects", async () => {
  await verifyScenario("startup");
}, 10_000);

test("restores text from SQLite for a deleted topic and confirmed starter deletion", async () => {
  await verifyScenario("missing-thread");
  await verifyScenario("starter-checks");
}, 20_000);

test("preserves a first publication snapshot when its topic is deleted during rendering", async () => {
  await verifyScenario("deletion-race");
}, 10_000);
