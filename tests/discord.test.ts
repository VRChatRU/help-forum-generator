import { afterEach, expect, spyOn, test } from "bun:test";
import {
  ChannelType,
  ReactionType,
  RESTJSONErrorCodes,
  Routes,
  type Client,
} from "discord.js";
import {
  createDiscord,
  fetchForumThread,
  fetchThreadMessages,
  inspectThread,
  isAnswerMessage,
  listForumThreads,
} from "../src/discord";

const config = {
  GUILD_ID: "100000000000000001",
  FORUM_CHANNEL_ID: "100000000000000002",
  PUBLISHER_ROLE_IDS: ["100000000000000003"],
  PUBLISH_EMOJI: "🌐",
  ANSWER_EMOJI: "✅",
};
const threadId = "100000000000000004";
const author = {
  id: "100000000000000005",
  username: "author",
  discriminator: "0",
  avatar: null,
};
const publisher = {
  id: "100000000000000006",
  username: "publisher",
  discriminator: "0",
  avatar: null,
};
const starterRoute = Routes.channelMessage(threadId, threadId);
const memberRoute = Routes.guildMember(config.GUILD_ID, publisher.id);

let client: Client | undefined;

afterEach(async () => {
  await client?.destroy();
  client = undefined;
});

function message(id: string) {
  return {
    id,
    channel_id: threadId,
    content: "Test",
    author,
    type: 0,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function reaction(emoji: string, normal: number, burst = 0) {
  return {
    emoji: { id: null, name: emoji },
    count: normal + burst,
    count_details: { normal, burst },
    me: false,
  };
}

async function setupDiscord(
  onGet: (route: string, query: URLSearchParams | undefined) => unknown,
) {
  const discord = (client = createDiscord());
  spyOn(discord.rest, "get").mockImplementation(async (route, options) => {
    if (route === Routes.guild(config.GUILD_ID))
      return { id: config.GUILD_ID, name: "Guild" };
    if (route === Routes.channel(threadId)) {
      return {
        id: threadId,
        type: ChannelType.PublicThread,
        parent_id: config.FORUM_CHANNEL_ID,
        guild_id: config.GUILD_ID,
      };
    }
    return onGet(route, options?.query);
  });
  await discord.guilds.fetch(config.GUILD_ID);
  const thread = await fetchForumThread(discord, config, threadId);
  if (!thread) throw new Error("Test thread was not loaded");
  return thread;
}

test("publication uses current Discord reactions and current publisher roles", async () => {
  let withReaction = true;
  let roles = config.PUBLISHER_ROLE_IDS;
  const thread = await setupDiscord((route) => {
    if (route === starterRoute) {
      return withReaction
        ? {
            ...message(threadId),
            reactions: [reaction(config.PUBLISH_EMOJI, 1)],
          }
        : message(threadId);
    }
    if (
      route ===
      Routes.channelMessageReaction(
        threadId,
        threadId,
        encodeURIComponent(config.PUBLISH_EMOJI),
      )
    )
      return [publisher];
    if (route === memberRoute) return { user: publisher, roles };
    throw new Error(`Unexpected REST request ${route}`);
  });

  // Fetch through the ordinary Discord.js path before inspecting the fresh snapshot.
  await thread.messages.fetch(threadId);
  expect((await inspectThread(thread, config)).status).toBe("published");

  roles = [];
  expect((await inspectThread(thread, config)).status).toBe("unpublished");

  roles = config.PUBLISHER_ROLE_IDS;
  withReaction = false;
  expect((await inspectThread(thread, config)).status).toBe("unpublished");
});

test("a deleted starter is missing and a temporary failure preserves that distinction", async () => {
  let failure: Error = Object.assign(new Error("Unknown Message"), {
    code: RESTJSONErrorCodes.UnknownMessage,
  });
  const thread = await setupDiscord((route) => {
    if (route === starterRoute) throw failure;
    throw new Error(`Unexpected REST request ${route}`);
  });

  expect(await inspectThread(thread, config)).toEqual({ status: "missing" });

  failure = new Error("Timed out");
  await expect(inspectThread(thread, config)).rejects.toBe(failure);
});

test("answer markers accept burst reactors beyond the first page and ignore bots", async () => {
  const replyId = "100000000000000007";
  const bots = Array.from({ length: 100 }, (_, index) => ({
    ...publisher,
    id: String(BigInt(author.id) - 1000n + BigInt(index)),
    bot: true,
  }));
  const cursors: (string | null | undefined)[] = [];
  const thread = await setupDiscord((route, query) => {
    if (route === Routes.channelMessage(threadId, replyId)) {
      return {
        ...message(replyId),
        reactions: [reaction(config.ANSWER_EMOJI, 0, 101)],
      };
    }
    if (
      route ===
      Routes.channelMessageReaction(
        threadId,
        replyId,
        encodeURIComponent(config.ANSWER_EMOJI),
      )
    ) {
      expect(query?.get("type")).toBe(String(ReactionType.Burst));
      cursors.push(query?.get("after"));
      return query?.has("after") ? [publisher] : bots;
    }
    if (route === memberRoute)
      return { user: publisher, roles: config.PUBLISHER_ROLE_IDS };
    throw new Error(`Unexpected REST request ${route}`);
  });

  const reply = await thread.messages.fetch(replyId);
  expect(await isAnswerMessage(reply, config)).toBe(true);
  expect(cursors).toEqual([null, bots.at(-1)?.id]);
});

test("fetches complete threads in chronological order", async () => {
  const ids = Array.from({ length: 103 }, (_, index) =>
    String(BigInt(threadId) + BigInt(index)),
  );
  const newestFirst = ids.toReversed();
  const thread = await setupDiscord((route, query) => {
    if (route !== Routes.channelMessages(threadId))
      throw new Error(`Unexpected REST request ${route}`);
    const before = query?.get("before");
    if (!before) return newestFirst.slice(0, 100).map(message);
    expect(before).toBe(newestFirst[99]!);
    return newestFirst.slice(100).map(message);
  });

  expect((await fetchThreadMessages(thread)).map((entry) => entry.id)).toEqual(
    ids,
  );
});

test("lists active and all archived threads belonging to the forum", async () => {
  const forumId = config.FORUM_CHANNEL_ID;
  const activeId = "100000000000000011";
  const newestArchivedId = "100000000000000012";
  const oldestArchivedId = "100000000000000013";
  const archivedAt = "2026-02-02T00:00:00.000Z";
  const active = {
    id: activeId,
    type: ChannelType.PublicThread,
    guild_id: config.GUILD_ID,
    parent_id: forumId,
    thread_metadata: {
      archived: false,
      archive_timestamp: "2026-01-01T00:00:00.000Z",
    },
  };
  const archived = {
    ...active,
    thread_metadata: { archived: true, archive_timestamp: archivedAt },
  };

  const discord = (client = createDiscord());
  const cursors: (string | null)[] = [];
  spyOn(discord.rest, "get").mockImplementation(async (route, options) => {
    if (route === Routes.guild(config.GUILD_ID))
      return { id: config.GUILD_ID, name: "Guild" };
    if (route === Routes.channel(forumId)) {
      return {
        id: forumId,
        type: ChannelType.GuildForum,
        guild_id: config.GUILD_ID,
        name: "Forum",
      };
    }
    if (route === Routes.guildActiveThreads(config.GUILD_ID)) {
      return {
        threads: [
          active,
          { ...active, id: threadId, parent_id: "100000000000000014" },
        ],
        members: [],
      };
    }
    if (route === Routes.channelThreads(forumId, "public")) {
      const before = options?.query?.get("before") ?? null;
      cursors.push(before);
      if (!before) {
        return {
          threads: [
            {
              ...archived,
              id: newestArchivedId,
              thread_metadata: {
                archived: true,
                archive_timestamp: "2026-02-03T00:00:00.000Z",
              },
            },
            archived,
          ],
          members: [],
          has_more: true,
        };
      }
      expect(before).toBe(archivedAt);
      return {
        threads: [
          {
            ...archived,
            id: oldestArchivedId,
            thread_metadata: {
              archived: true,
              archive_timestamp: "2026-02-01T00:00:00.000Z",
            },
          },
        ],
        members: [],
        has_more: false,
      };
    }
    throw new Error(`Unexpected REST request ${route}`);
  });
  await discord.guilds.fetch(config.GUILD_ID);
  const forum = await discord.channels.fetch(forumId);
  if (forum?.type !== ChannelType.GuildForum)
    throw new Error("Test forum was not loaded");

  const threads = await listForumThreads(forum, config);
  expect(threads.map((thread) => thread.id)).toEqual([
    activeId,
    newestArchivedId,
    oldestArchivedId,
  ]);
  expect(cursors).toEqual([null, archivedAt]);
});
