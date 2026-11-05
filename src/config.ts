import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
export const databasePath = join(root, "help-forum-generator.db");
export const logPath = join(root, "help-forum-generator.log");

const env = Bun.env;

export function siteConfig() {
  const baseUrl = env.BASE_URL?.trim()
    ? httpUrl(env.BASE_URL, "BASE_URL")
    : undefined;
  if (baseUrl) {
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/`;
    baseUrl.search = "";
    baseUrl.hash = "";
  }

  return {
    OUTPUT_DIR: resolve(root, env.OUTPUT_DIR?.trim() || "website"),
    LEGACY_OUTPUT_DIR: env.LEGACY_OUTPUT_DIR?.trim() || undefined,
    GUILD_ID: env.GUILD_ID?.trim() || "666306330230915093",
    FORUM_CHANNEL_ID: env.FORUM_CHANNEL_ID?.trim() || "1019662051825680404",
    PUBLISH_EMOJI: env.PUBLISH_EMOJI?.trim() || "🌐",
    ANSWER_EMOJI: env.ANSWER_EMOJI?.trim() || "✅",
    SITE_TITLE: env.SITE_TITLE?.trim() || "База знаний VRChatRU",
    SITE_DESCRIPTION:
      env.SITE_DESCRIPTION?.trim() ||
      "Помощь по VRChat, ответы на частые вопросы, ошибки, советы и гайды из форума VRChatRU",
    BASE_URL: baseUrl?.href,
  };
}

export function discordConfig(site: ReturnType<typeof siteConfig>) {
  const roles = required("PUBLISHER_ROLE_ID")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (roles.length === 0)
    throw new Error("Set at least one publisher role in PUBLISHER_ROLE_ID");

  return {
    ...site,
    BOT_TOKEN: required("BOT_TOKEN"),
    GUILD_ID: required("GUILD_ID"),
    FORUM_CHANNEL_ID: required("FORUM_CHANNEL_ID"),
    PUBLISHER_ROLE_IDS: [...new Set(roles)],
    LOG_CHANNEL_ID: env.LOG_CHANNEL_ID?.trim() || undefined,
    UPTIME_KUMA_PUSH_URL: httpUrl(
      required("UPTIME_KUMA_PUSH_URL"),
      "UPTIME_KUMA_PUSH_URL",
    ),
  };
}

export function caddyConfig(site: ReturnType<typeof siteConfig>) {
  const value = env.CADDY_ADMIN_URL?.trim();
  if (!value) return;
  const admin = httpUrl(value, "CADDY_ADMIN_URL");
  if (
    admin.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(admin.hostname) ||
    admin.pathname !== "/" ||
    admin.search ||
    admin.hash
  )
    throw new Error("CADDY_ADMIN_URL must be a local HTTP origin");

  const url = new URL(site.BASE_URL ?? "https://help.vrcru.org/");
  if (url.pathname !== "/" || !/^[a-z0-9][a-z0-9.-]*$/.test(url.hostname))
    throw new Error("Caddy registration requires a site origin in BASE_URL");

  return {
    admin,
    url,
    outputDir: site.OUTPUT_DIR,
    serverName: env.CADDY_SERVER_NAME?.trim() || undefined,
  };
}

export type Config = ReturnType<typeof discordConfig>;

function required(name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env`);
  return value;
}

function httpUrl(value: string, name: string): URL {
  const url = URL.canParse(value) ? new URL(value) : null;
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(`Set a valid HTTP(S) URL in ${name}`);
  }
  return url;
}
