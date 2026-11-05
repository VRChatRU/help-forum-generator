export type CaddyAdmin = { url: URL; socket?: string };

export type CaddyRoute = Record<string, unknown>;

export type CaddySite = {
  host: string;
  routes: CaddyRoute[];
  errorRoutes: CaddyRoute[];
};

type CaddyServer = Record<string, unknown> & {
  listen?: string[];
  routes?: CaddyRoute[];
  errors?: Record<string, unknown> & { routes?: CaddyRoute[] };
};

const serversPath = "/config/apps/http/servers";
const routeId = "help-forum-generator";
const errorRouteId = "help-forum-generator-errors";

export function caddyFetch(
  admin: CaddyAdmin,
  path: string,
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  return fetch(new URL(path, admin.url), {
    ...init,
    unix: admin.socket,
    redirect: "error",
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ownsHost(route: CaddyRoute, host: string): boolean {
  if (route["@id"] === routeId || route["@id"] === errorRouteId) return false;
  if (
    Array.isArray(route.match) &&
    route.match.some(
      (matcher) =>
        isObject(matcher) &&
        Array.isArray(matcher.host) &&
        matcher.host.some(
          (value) =>
            typeof value === "string" &&
            value.toLowerCase().replace(/\.$/, "") === host,
        ),
    )
  )
    return true;

  return (
    Array.isArray(route.handle) &&
    route.handle.some(
      (handler) =>
        isObject(handler) &&
        Array.isArray(handler.routes) &&
        handler.routes.some(
          (nested) => isObject(nested) && ownsHost(nested, host),
        ),
    )
  );
}

function siteRoute(id: string, host: string, routes: CaddyRoute[]): CaddyRoute {
  return {
    "@id": id,
    match: [{ host: [host] }],
    handle: [{ handler: "subroute", routes }],
    ...(id === routeId && { terminal: true }),
  };
}

export async function ensureCaddySite(
  admin: CaddyAdmin,
  site: CaddySite,
  serverName: string | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  const host = site.host.toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(host) || !site.routes.length) {
    throw new Error(
      "Caddy registration requires an exact hostname and a site route",
    );
  }

  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const response = await caddyFetch(admin, serversPath, {
    signal: requestSignal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Could not read Caddy servers (HTTP ${response.status})`);
  }
  const etag = response.headers.get("etag");
  const servers = (await response.json()) as Record<string, CaddyServer> | null;
  const entries = Object.entries(servers ?? {});
  const managed = entries.filter(
    ([, server]) =>
      server.routes?.some((route) => route["@id"] === routeId) ||
      server.errors?.routes?.some((route) => route["@id"] === errorRouteId),
  );
  if (
    managed.length > 1 ||
    (serverName !== undefined && managed[0] && managed[0][0] !== serverName)
  ) {
    throw new Error("The managed site already belongs to another Caddy server");
  }

  const candidates = entries.filter(([name, server]) =>
    serverName !== undefined
      ? name === serverName
      : server.listen?.some((address) => address.endsWith(":443")),
  );
  const selected =
    managed[0] ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!selected) {
    throw new Error(
      serverName === undefined
        ? "Could not select a unique Caddy listener on port 443. Set CADDY_SERVER_NAME"
        : `Caddy server "${serverName}" was not found`,
    );
  }

  if (
    entries.some(([, server]) =>
      [...(server.routes ?? []), ...(server.errors?.routes ?? [])].some(
        (route) => ownsHost(route, host),
      ),
    )
  ) {
    throw new Error(`Caddy already has an unmanaged route for ${host}`);
  }

  const [name, server] = selected;
  const updated = {
    ...server,
    routes: [
      siteRoute(routeId, host, site.routes),
      ...(server.routes ?? []).filter((route) => route["@id"] !== routeId),
    ],
  };
  const previousErrors = server.errors?.routes ?? [];
  if (
    site.errorRoutes.length ||
    previousErrors.some((route) => route["@id"] === errorRouteId)
  ) {
    updated.errors = {
      ...server.errors,
      routes: [
        ...(site.errorRoutes.length
          ? [siteRoute(errorRouteId, host, site.errorRoutes)]
          : []),
        ...previousErrors.filter((route) => route["@id"] !== errorRouteId),
      ],
    };
  }

  if (Bun.deepEquals(server, updated)) return false;
  if (!etag)
    throw new Error(
      "Caddy did not return an ETag for the server configuration",
    );
  if (/[/\\]/.test(name) || name === "." || name === "..") {
    throw new Error(
      "The Caddy server name cannot be used in an Admin API path",
    );
  }

  const patched = await caddyFetch(
    admin,
    `${serversPath}/${encodeURIComponent(name)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", "if-match": etag },
      body: JSON.stringify(updated),
      signal: requestSignal,
    },
  );
  await patched.body?.cancel();
  if (!patched.ok) {
    throw new Error(
      patched.status === 412
        ? "Caddy configuration changed during site registration"
        : `Caddy rejected site registration (HTTP ${patched.status})`,
    );
  }
  return true;
}
