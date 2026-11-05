import { once } from "node:events";
import { parseArgs } from "node:util";
import { Archive, isThreadId } from "./src/archive";
import { databasePath, discordConfig, logPath, siteConfig } from "./src/config";
import { SiteOutput } from "./src/output";
import { runPublication } from "./src/publication";
import { renderSite } from "./src/render";
import { createLogger, runHeartbeat } from "./src/runtime";

const log = createLogger(logPath, [
  Bun.env.BOT_TOKEN ?? "",
  Bun.env.UPTIME_KUMA_PUSH_URL ?? "",
]);
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  void once(process, signal, { signal: stop.signal })
    .then(() => stop.abort())
    .catch(() => {});
}

function parseThreadReference(reference: string): string {
  if (isThreadId(reference)) return reference;

  const url = URL.parse(reference);
  if (url && (url.protocol === "http:" || url.protocol === "https:")) {
    const pattern = /^(?:(?:www|canary|ptb)\.)?discord(?:app)?\.com$/.test(
      url.hostname,
    )
      ? /^\/channels\/\d+\/(\d+)(?:\/\d+)?\/?$/
      : /\/threads\/(\d+)(?:\/index\.html)?\/?$/;
    const id = pattern.exec(url.pathname)?.[1];
    if (id && isThreadId(id)) return id;
  }

  throw new Error(
    "Use a Discord thread ID, a Discord thread URL, or a site thread URL after --rebuild",
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(Bun.argv[2] === "--" ? 3 : 2),
    options: {
      restore: { type: "boolean" },
      scan: { type: "boolean" },
      rebuild: { type: "boolean" },
    },
    allowPositionals: true,
  });
  const { restore: restoreOnly, scan, rebuild } = values;
  if (scan && (restoreOnly || rebuild)) {
    throw new Error("Use --scan separately from --restore and --rebuild");
  }
  if (
    positionals.length > 1 ||
    (positionals.length && (!rebuild || restoreOnly))
  ) {
    throw new Error("Use at most one thread reference with --rebuild");
  }
  const rebuildThreadId =
    positionals[0] === undefined
      ? undefined
      : parseThreadReference(positionals[0]);
  const site = siteConfig();
  const config = restoreOnly ? undefined : discordConfig(site);
  const heartbeat =
    config && runHeartbeat(config.UPTIME_KUMA_PUSH_URL, stop.signal);
  let archive: Archive | undefined;

  try {
    archive = new Archive(databasePath);
    const output = new SiteOutput(site.OUTPUT_DIR, archive);
    const onIssue = (message: string, error?: unknown) =>
      log.warn(message, { error });

    let imported = site.LEGACY_OUTPUT_DIR
      ? await output.importLegacy(site.LEGACY_OUTPUT_DIR, onIssue)
      : 0;
    imported += await output.importLegacy(undefined, onIssue);
    if (imported)
      log.info("Imported existing pages into SQLite", { pages: imported });

    const restored = await output.restore();
    await output.writeSite(await renderSite(archive.list(), site));
    log.info("Restored the site from SQLite", {
      pages: restored,
      output: site.OUTPUT_DIR,
    });

    if (config && !stop.signal.aborted) {
      await runPublication(
        config,
        archive,
        output,
        log,
        scan
          ? { mode: "scan" }
          : rebuild
            ? { mode: "rebuild", threadId: rebuildThreadId }
            : undefined,
        stop.signal,
      );
    }
  } finally {
    stop.abort();
    await heartbeat;
    archive?.close();
  }
}

try {
  await main();
} catch (error) {
  log.error("help-forum-generator exited with an error", { error });
  process.exitCode = 1;
} finally {
  stop.abort();
}
