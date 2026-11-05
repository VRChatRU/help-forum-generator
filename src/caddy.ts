import { setTimeout as wait } from "node:timers/promises";
import {
  ensureCaddySite,
  type CaddyRoute,
  type CaddySite,
} from "./caddy-admin";
import type { caddyConfig } from "./config";
import { retryDelay, type Logger } from "./runtime";

type Settings = NonNullable<ReturnType<typeof caddyConfig>>;
type AdaptedServer = {
  routes?: CaddyRoute[];
  errors?: { routes?: CaddyRoute[] };
};

const caddyfile = new URL("../Caddyfile", import.meta.url);
const addressVariable = "{$HELP_SITE_ADDRESS:help.vrcru.org}";
const rootVariable = "{$HELP_WEB_ROOT:./website}";

async function adaptSite(
  config: Settings,
  signal: AbortSignal,
): Promise<CaddySite> {
  const root =
    process.platform === "win32"
      ? config.outputDir.replaceAll("\\", "/")
      : config.outputDir;
  if (/["{}\\\x00-\x1f]/.test(root))
    throw new Error("OUTPUT_DIR cannot be used as a Caddy root");

  const template = await Bun.file(caddyfile).text();
  if (!template.includes(addressVariable) || !template.includes(rootVariable))
    throw new Error(
      "The project Caddyfile is missing its site or root setting",
    );

  const body = template
    .replaceAll("https://help.vrcru.org", () => config.url.origin)
    .replace(addressVariable, () => config.url.origin)
    .replace(rootVariable, () => root);
  const response = await fetch(new URL("/adapt", config.admin), {
    method: "POST",
    headers: { "Content-Type": "text/caddyfile" },
    body,
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Caddy could not adapt the project Caddyfile (HTTP ${response.status})`,
    );
  }

  const { result } = (await response.json()) as {
    result?: { apps?: { http?: { servers?: Record<string, AdaptedServer> } } };
  };
  const [server, ...others] = Object.values(result?.apps?.http?.servers ?? {});
  if (others.length || !server?.routes?.length)
    throw new Error(
      "The project Caddyfile must define one HTTP server with routes",
    );

  return {
    host: config.url.hostname,
    routes: server.routes,
    errorRoutes: server.errors?.routes ?? [],
  };
}

export async function runCaddyRegistration(
  config: Settings,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  let site: CaddySite | undefined;
  let failures = 0;
  while (!signal.aborted) {
    const request = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    try {
      site ??= await adaptSite(config, request);
      if (await ensureCaddySite(config.admin, site, config.serverName, request))
        log.info("Registered the site with Caddy", { host: site.host });
      else if (failures)
        log.info("Caddy registration recovered", { host: site.host });
      failures = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (failures++ === 0)
        log.warn("Caddy registration failed and will be retried", { error });
    }
    await wait(failures ? retryDelay(failures) : 30_000, undefined, {
      signal,
    }).catch(() => {});
  }
}
