import { setTimeout as wait } from "node:timers/promises";
import {
  ChannelType,
  Events,
  GatewayDispatchEvents,
  escapeMarkdown,
  type Client,
  type ForumChannel,
  type GatewayMessageReactionAddDispatchData,
  type GatewayMessageReactionRemoveDispatchData,
  type GatewayMessageDeleteDispatchData,
  type GatewayMessageDeleteBulkDispatchData,
  type GatewayThreadDeleteDispatchData,
  type ThreadChannel,
} from "discord.js";
import type { Archive, Page } from "./archive";
import type { Config } from "./config";
import {
  createDiscord,
  fetchForumThread,
  fetchThreadMessages,
  inspectThread,
  isAnswerMessage,
  isForumThread,
  isPublisher,
  listForumThreads,
  matchesEmoji,
} from "./discord";
import type { SiteOutput } from "./output";
import { renderArchivedThread, renderSite, renderThread } from "./render";
import { retryDelay, WorkQueue, type Logger } from "./runtime";

const priority = { output: 0, reaction: 1, setup: 2, backfill: 3, batch: 4 };

type Notice = { client: Client; actor: string; text: string };
type ReactionEvent =
  | GatewayMessageReactionAddDispatchData
  | GatewayMessageReactionRemoveDispatchData;

export async function runPublication(
  config: Config,
  archive: Archive,
  output: SiteOutput,
  log: Logger,
  startup:
    { mode: "scan" } | { mode: "rebuild"; threadId?: string } | undefined,
  signal: AbortSignal,
): Promise<void> {
  const queue = new WorkQueue(log);
  const changed = new Map<string, { page?: Page; notice?: Notice }>();
  let startupQueued = false;
  let scanQueued = false;
  let announced = false;
  let client = createDiscord();
  const stopping = Promise.withResolvers<number | undefined>();
  signal.addEventListener("abort", () => stopping.resolve(undefined), {
    once: true,
  });

  function markChanged(id: string, page?: Page, notice?: Notice) {
    changed.set(id, { page, notice });
    queue.enqueue(
      "site",
      notice ? priority.output : priority.batch,
      async () => {
        for (const [id, change] of changed) {
          const thread = archive.get(id);
          if (thread?.published)
            await output.writePage(
              change.page ?? (await renderArchivedThread(thread, config)),
            );
          else await output.removePage(id);
        }
        await output.writeSite(await renderSite(archive.list(), config));
        log.info("Site updated", { pages: changed.size });

        for (const { notice } of changed.values()) {
          if (notice) notify(notice.client, notice.text, notice.actor);
        }
        changed.clear();
      },
      false,
    );
  }

  async function sendChannelNotification(source: Client, text: string) {
    if (!config.LOG_CHANNEL_ID) return;
    const channel = await source.channels.fetch(config.LOG_CHANNEL_ID);
    if (!channel?.isSendable())
      throw new Error("The notification channel does not accept messages");
    await channel.send({ content: text, allowedMentions: { parse: [] } });
  }

  function notify(source: Client, text: string, actor?: string) {
    const message = { content: text, allowedMentions: { parse: [] as [] } };
    if (config.LOG_CHANNEL_ID) {
      void sendChannelNotification(source, text).catch((error: unknown) =>
        log.warn("Could not send a notification to the Discord channel", {
          error,
        }),
      );
    }
    if (actor) void source.users.send(actor, message).catch(() => {});
  }

  function noticeFor(
    thread: ThreadChannel,
    actor: string,
    published: boolean,
  ): Notice {
    const text = [
      published
        ? "**Страница сгенерирована ✅**"
        : "**Страница снята с публикации 🗑️**",
      `- "${escapeMarkdown(thread.name)}"`,
      published && config.BASE_URL
        ? `- [Открыть на сайте](${new URL(`threads/${thread.id}/index.html`, config.BASE_URL)})`
        : "",
      `- [Открыть в Discord](${thread.url})`,
      `- ${published ? "Добавил" : "Удалил"} <@${actor}>`,
    ]
      .filter(Boolean)
      .join("\n");
    return { client: thread.client, actor, text };
  }

  async function saveThread(thread: ThreadChannel, actor?: string) {
    const messages = await fetchThreadMessages(thread);
    if (!messages.some((message) => message.id === thread.id)) {
      const { status } = await inspectThread(thread, config);
      if (status === "missing") restoreMissingThread(thread.id);
      else
        throw new Error(
          `Discord returned an incomplete message history for thread ${thread.id}`,
        );
      return false;
    }

    const checked = new Map<string, boolean>();
    const rendering = new AbortController();
    const renderSignal = AbortSignal.any([signal, rendering.signal]);
    try {
      const page = await renderThread(
        thread,
        messages,
        config,
        {
          get: async (path) => {
            renderSignal.throwIfAborted();
            return output.hasAsset(path);
          },
          add: async (path, bytes) => {
            renderSignal.throwIfAborted();
            await output.writeAsset(path, bytes);
          },
        },
        (message) => isAnswerMessage(message, config, checked),
        renderSignal,
        (snapshot) => {
          renderSignal.throwIfAborted();
          archive.save(snapshot);
          log.info("Thread and messages saved to SQLite", {
            threadId: thread.id,
            messages: messages.length,
            actor,
          });
        },
      );
      renderSignal.throwIfAborted();
      markChanged(
        thread.id,
        page,
        actor ? noticeFor(thread, actor, true) : undefined,
      );
    } finally {
      rendering.abort();
    }
    return true;
  }

  function restoreMissingThread(threadId: string) {
    const thread = archive.get(threadId);
    if (!thread) return;
    archive.setSourceMissing(threadId, true);
    if (thread.published) markChanged(threadId);
    log.info(
      "Discord source is missing. Restoring archived text without media",
      { threadId },
    );
  }

  async function refreshThread(threadId: string) {
    if (!archive.get(threadId)?.published) return;
    const thread = await fetchForumThread(client, config, threadId);
    if (thread) await syncThread(thread);
    else restoreMissingThread(threadId);
  }

  async function syncThread(
    thread: ThreadChannel,
    { actor, unpublish = true }: { actor?: string; unpublish?: boolean } = {},
  ): Promise<boolean> {
    const { status } = await inspectThread(thread, config);
    if (status === "published") return saveThread(thread, actor);

    const threadId = thread.id;
    if (
      status === "unpublished" &&
      unpublish &&
      archive.setPublished(threadId, false)
    ) {
      log.info("Page unpublished", { threadId, actor });
      markChanged(
        threadId,
        undefined,
        actor ? noticeFor(thread, actor, false) : undefined,
      );
    } else if (status === "missing" && archive.hasPage(threadId)) {
      restoreMissingThread(threadId);
    }
    return false;
  }

  function onSourceDeleted(threadId: string) {
    queue.enqueue(
      `deleted:${threadId}`,
      priority.reaction,
      async () => {
        restoreMissingThread(threadId);
      },
      false,
    );
  }

  function onReaction(event: ReactionEvent, removed: boolean) {
    const id = event.channel_id;
    if (
      event.guild_id !== config.GUILD_ID ||
      id !== event.message_id ||
      !matchesEmoji(event.emoji, config.PUBLISH_EMOJI) ||
      ("member" in event && event.member?.user.bot)
    )
      return;
    const channel = client.channels.cache.get(id);
    if (channel && !isForumThread(channel, config)) return;

    const actor = event.user_id;
    queue.enqueue(`reaction:${id}:${actor}`, priority.reaction, async () => {
      const thread = await fetchForumThread(client, config, id);
      if (!thread || !(await isPublisher(thread, config, actor))) return;

      await syncThread(thread, { actor, unpublish: removed });
    });
  }

  async function queueScan(forum: ForumChannel) {
    const threads = await listForumThreads(forum, config, signal);
    log.info("Checking forum starter messages for publication reactions", {
      threads: threads.length,
    });
    let remaining = threads.length;
    let saved = 0;

    function logComplete() {
      log.info("Forum scan completed", {
        checked: threads.length,
        saved,
      });
    }

    if (remaining === 0) logComplete();
    for (const thread of threads) {
      queue.enqueue(`scan:${thread.id}`, priority.backfill, async () => {
        if (await syncThread(thread)) saved++;
        remaining--;
        if (remaining === 0) logComplete();
      });
    }
  }

  function onReady() {
    queue.setConnected(true);
    if (!announced) {
      queue.enqueue("startup-notice", priority.setup, async () => {
        if (announced) return;
        await sendChannelNotification(
          client,
          "vrcru-help-forum-generator перезагружен",
        );
        announced = true;
      });
    }
    queue.enqueue("forum", priority.setup, async () => {
      const forum = await client.channels.fetch(config.FORUM_CHANNEL_ID, {
        force: true,
      });
      if (
        forum?.type !== ChannelType.GuildForum ||
        forum.guildId !== config.GUILD_ID
      ) {
        throw new Error(
          "The configured channel is not a forum in the configured Discord server",
        );
      }

      if (!startupQueued) {
        const target =
          startup?.mode === "rebuild" ? startup.threadId : undefined;
        const threadIds = target
          ? [target]
          : archive.list().map(({ threadId }) => threadId);
        log.info("Queued archived threads for verification", {
          pages: threadIds.length,
          threadId: target,
        });
        if (startup?.mode === "rebuild" && !target)
          notify(client, "Запущена перегенерация всех страниц.");
        for (const threadId of threadIds) {
          queue.enqueue(`rebuild:${threadId}`, priority.backfill, async () => {
            if (!archive.get(threadId)?.published) {
              if (target)
                log.warn("No published page found for the requested thread", {
                  threadId,
                });
              return;
            }
            await refreshThread(threadId);
          });
        }
        startupQueued = true;
      }
      if (startup?.mode === "scan" && !scanQueued) {
        await queueScan(forum);
        scanQueued = true;
      }

      log.info("Ready to process forum reactions", { forumId: forum.id });
    });
  }

  try {
    let attempts = 0;
    while (!signal.aborted) {
      const disconnected = Promise.withResolvers<number>();
      let closeCode: number | undefined;
      client.ws.on(
        GatewayDispatchEvents.MessageReactionAdd,
        (data: GatewayMessageReactionAddDispatchData) =>
          onReaction(data, false),
      );
      client.ws.on(
        GatewayDispatchEvents.MessageReactionRemove,
        (data: GatewayMessageReactionRemoveDispatchData) =>
          onReaction(data, true),
      );
      client.ws.on(
        GatewayDispatchEvents.ThreadDelete,
        (data: GatewayThreadDeleteDispatchData) => {
          if (
            data.guild_id === config.GUILD_ID &&
            data.parent_id === config.FORUM_CHANNEL_ID
          )
            onSourceDeleted(data.id);
        },
      );
      client.ws.on(
        GatewayDispatchEvents.MessageDelete,
        (data: GatewayMessageDeleteDispatchData) => {
          if (data.guild_id === config.GUILD_ID && data.id === data.channel_id)
            onSourceDeleted(data.channel_id);
        },
      );
      client.ws.on(
        GatewayDispatchEvents.MessageDeleteBulk,
        (data: GatewayMessageDeleteBulkDispatchData) => {
          if (
            data.guild_id === config.GUILD_ID &&
            data.ids.includes(data.channel_id)
          )
            onSourceDeleted(data.channel_id);
        },
      );
      let reconnecting = false;
      client.on(Events.ClientReady, () => {
        reconnecting = false;
        log.info("Connected to Discord");
        onReady();
      });
      client.on(Events.ShardReconnecting, () => {
        queue.setConnected(false);
        if (!reconnecting)
          log.warn("Lost the Discord connection. Reconnecting");
        reconnecting = true;
      });
      client.on(Events.ShardResume, () => {
        if (reconnecting) log.info("Discord connection resumed");
        reconnecting = false;
        queue.setConnected(true);
      });
      client.on(Events.ShardReady, () => {
        if (reconnecting) log.info("Reconnected to Discord");
        reconnecting = false;
        queue.setConnected(true);
      });
      client.on(Events.Error, (error) => log.warn("Discord error", { error }));
      client.on(Events.ShardError, (error) => {
        if (!reconnecting) log.warn("Discord connection error", { error });
      });
      client.on(Events.ShardDisconnect, ({ code }) => {
        closeCode = code;
        disconnected.resolve(code);
      });

      try {
        await Promise.race([client.login(config.BOT_TOKEN), stopping.promise]);
      } catch (error) {
        if (signal.aborted) return;
        if (closeCode !== undefined) throw gatewayError(closeCode);
        if (
          typeof error === "object" &&
          error !== null &&
          (("code" in error && error.code === "TokenInvalid") ||
            ("status" in error && error.status === 401))
        )
          throw new Error("Discord rejected BOT_TOKEN", { cause: error });
        if (attempts === 0)
          log.warn("Discord connection failed and will be retried", { error });
        attempts += 1;
        await wait(retryDelay(attempts), undefined, { signal }).catch(() => {});
        if (!signal.aborted) client = createDiscord();
        continue;
      }

      if (signal.aborted) return;
      const code = await Promise.race([disconnected.promise, stopping.promise]);
      if (code !== undefined) throw gatewayError(code);
      return;
    }
  } finally {
    await queue.stop();
    await client.destroy();
  }
}

function gatewayError(code: number): Error {
  if (code === 4014)
    return new Error(
      "Discord rejected the connection. Enable the Message Content Intent for the bot.",
    );
  return new Error(`Discord closed the connection with code ${code}`);
}
