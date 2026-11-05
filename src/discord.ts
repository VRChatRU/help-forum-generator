import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Options,
  Partials,
  ReactionType,
  RESTJSONErrorCodes,
  Routes,
  type AnyThreadChannel,
  type Channel,
  type ForumChannel,
  type Message,
  type PublicThreadChannel,
  type RESTGetAPIGuildMemberResult,
  type ThreadChannel,
} from "discord.js";

type ForumConfig = {
  GUILD_ID: string;
  FORUM_CHANNEL_ID: string;
};

type PublisherConfig = { PUBLISHER_ROLE_IDS: readonly string[] };
type PublishConfig = PublisherConfig & { PUBLISH_EMOJI: string };
type AnswerConfig = PublisherConfig & { ANSWER_EMOJI: string };
type Inspection = { status: "missing" | "unpublished" | "published" };

const pageSize = 100;

export function createDiscord(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.Reaction,
      Partials.User,
    ],
    // REST snapshots must never inherit reactions that disappeared from Discord.
    makeCache: Options.cacheWithLimits({
      MessageManager: 0,
      ReactionUserManager: 0,
    }),
    rest: { timeout: 10_000, retries: 2 },
  });
}

export function isForumThread(
  channel: Channel | null | undefined,
  config: ForumConfig,
): channel is PublicThreadChannel {
  return (
    channel?.isThread() === true &&
    channel.type === ChannelType.PublicThread &&
    channel.guildId === config.GUILD_ID &&
    channel.parentId === config.FORUM_CHANNEL_ID
  );
}

export async function listForumThreads(
  forum: ForumChannel,
  config: ForumConfig,
  signal?: AbortSignal,
): Promise<PublicThreadChannel[]> {
  const threads = new Map<string, PublicThreadChannel>();
  function collect(batch: Iterable<AnyThreadChannel>): void {
    for (const thread of batch) {
      if (isForumThread(thread, config)) threads.set(thread.id, thread);
    }
  }

  signal?.throwIfAborted();
  const active = await forum.threads.fetchActive();
  collect(active.threads.values());

  let before: Date | undefined;
  while (true) {
    signal?.throwIfAborted();
    const page = await forum.threads.fetchArchived({
      type: "public",
      limit: pageSize,
      before,
    });
    signal?.throwIfAborted();
    collect(page.threads.values());
    if (!page.hasMore) return [...threads.values()];

    const cursor = page.threads.last()?.archivedAt;
    if (
      !cursor ||
      !Number.isFinite(cursor.getTime()) ||
      (before && cursor >= before)
    ) {
      throw new Error(
        `Discord did not return the next archive cursor for forum ${forum.id}`,
      );
    }
    before = cursor;
  }
}

export async function fetchForumThread(
  client: Client,
  config: ForumConfig,
  id: string,
): Promise<ThreadChannel | null> {
  try {
    const channel = await client.channels.fetch(id, { force: true });
    if (!channel) throw new Error(`Discord did not return channel ${id}`);
    return isForumThread(channel, config) ? channel : null;
  } catch (error) {
    if (hasCode(error, RESTJSONErrorCodes.UnknownChannel)) return null;
    throw error;
  }
}

export function matchesEmoji(
  emoji: { id: string | null; name: string | null },
  expected: string,
): boolean {
  return emoji.id === expected || emoji.name === expected;
}

export function isPublisher(
  thread: ThreadChannel,
  config: PublisherConfig,
  userId: string,
): Promise<boolean> {
  return memberCanPublish(thread.client, thread.guildId, config, userId);
}

async function memberCanPublish(
  client: Client,
  guildId: string,
  config: PublisherConfig,
  userId: string,
): Promise<boolean> {
  try {
    const member = (await client.rest.get(
      Routes.guildMember(guildId, userId),
    )) as RESTGetAPIGuildMemberResult;
    if (!member.user) throw new Error(`Discord did not return user ${userId}`);
    return (
      !member.user.bot &&
      config.PUBLISHER_ROLE_IDS.some(
        (role) => role === guildId || member.roles.includes(role),
      )
    );
  } catch (error) {
    if (hasCode(error, RESTJSONErrorCodes.UnknownMember)) return false;
    throw error;
  }
}

export async function inspectThread(
  thread: ThreadChannel,
  config: PublishConfig,
): Promise<Inspection> {
  try {
    // A forum post's starter has the same ID as the thread and belongs to it.
    const starter = await thread.messages.fetch({
      message: thread.id,
      force: true,
      cache: false,
    });
    if (!starter.inGuild())
      throw new Error(`Missing guild data for thread ${thread.id}`);
    const published = await hasPublisherReaction(
      starter,
      config.PUBLISH_EMOJI,
      config,
      new Map(),
    );
    return { status: published ? "published" : "unpublished" };
  } catch (error) {
    if (
      hasCode(error, RESTJSONErrorCodes.UnknownChannel) ||
      hasCode(error, RESTJSONErrorCodes.UnknownMessage)
    ) {
      return { status: "missing" };
    }
    throw error;
  }
}

export async function isAnswerMessage(
  message: Message,
  config: AnswerConfig,
  checks = new Map<string, boolean>(),
): Promise<boolean> {
  if (!message.inGuild()) return false;
  return hasPublisherReaction(message, config.ANSWER_EMOJI, config, checks);
}

async function hasPublisherReaction(
  message: Message<true>,
  expected: string,
  config: PublisherConfig,
  checks: Map<string, boolean>,
): Promise<boolean> {
  for (const reaction of message.reactions.cache.values()) {
    if (!matchesEmoji(reaction.emoji, expected)) continue;

    for (const type of [ReactionType.Normal, ReactionType.Burst]) {
      const count =
        type === ReactionType.Burst
          ? reaction.countDetails.burst
          : reaction.countDetails.normal;
      if (!count) continue;

      let after: string | undefined;
      while (true) {
        const users = await reaction.users.fetch({
          type,
          limit: pageSize,
          after,
        });
        for (const user of users.values()) {
          if (user.bot) continue;
          let allowed = checks.get(user.id);
          if (allowed === undefined) {
            allowed = await memberCanPublish(
              message.client,
              message.guildId,
              config,
              user.id,
            );
            checks.set(user.id, allowed);
          }
          if (allowed) return true;
        }
        if (users.size < pageSize) break;

        const cursor = users.lastKey();
        if (!cursor || (after && compareId(cursor, after) <= 0)) {
          throw new Error(
            `Discord did not return the next reaction cursor for message ${message.id}`,
          );
        }
        after = cursor;
      }
    }
  }
  return false;
}

export async function fetchThreadMessages(
  thread: ThreadChannel,
): Promise<Message[]> {
  const messages: Message[] = [];
  let before: string | undefined;
  while (true) {
    const batch = await thread.messages.fetch({
      limit: pageSize,
      before,
      cache: false,
    });
    messages.push(...batch.values());
    if (batch.size < pageSize) break;

    const cursor = batch.lastKey();
    if (!cursor || (before && compareId(cursor, before) >= 0)) {
      throw new Error(
        `Discord did not return the next message cursor for thread ${thread.id}`,
      );
    }
    before = cursor;
  }
  return messages.reverse();
}

function compareId(left: string, right: string): number {
  return left.length - right.length || left.localeCompare(right);
}

function hasCode(error: unknown, code: RESTJSONErrorCodes): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
