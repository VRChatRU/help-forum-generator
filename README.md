# help-forum-generator

Publishes approved VRChatRU Discord forum threads as a static site and archives pages and attachments.

1. Install Bun 1.4.4 or later and run `bun install --frozen-lockfile`.
2. Copy `example.env` to `.env` and fill in the Discord settings and `UPTIME_KUMA_PUSH_URL`. Enable **Message Content Intent** and grant the bot **View Channel** and **Read Message History** in the forum. If you set `LOG_CHANNEL_ID`, also grant **Send Messages** in that channel.
3. Run `bun run start` to generate the site in `website/`. Relative `OUTPUT_DIR` paths are resolved from the project directory. Set `LEGACY_OUTPUT_DIR` to import old site files from another directory.
4. To register the site with a running Caddy instance, set `CADDY_ADMIN_URL=http://127.0.0.1:2019` in `.env`. The app adds the site to the existing HTTPS listener and restores its route after Caddy reloads. Set `CADDY_SERVER_NAME` if Caddy has no unique listener on port 443. Give Caddy read access to `website/`. Leave `CADDY_ADMIN_URL` blank to manage Caddy separately.

- `bun run start --scan` checks active and archived threads and publishes those with a publication reaction from an authorized user.
- `bun run start --rebuild` checks existing publications and refreshes pages with a valid publication reaction.
- `bun run start --rebuild <thread-id-or-url>` refreshes one published page using its thread ID, Discord link, or site link.
- `bun run start --restore` restores the site from `help-forum-generator.db` without connecting to Discord.

Scan and rebuild hide pages whose original posts still exist without a valid publication reaction. If the original post was deleted, the archived page stays published.
