import { expect, spyOn, test } from "bun:test";
import {
  type CaddyAdmin,
  type CaddySite,
  ensureCaddySite,
} from "../src/caddy-admin";

const admin = { url: new URL("http://127.0.0.1:2019") };
const serverPath = "/config/apps/http/servers";
const etag = `"${serverPath} test"`;
const host = "help.example.test";
const site: CaddySite = {
  host,
  routes: [{ handle: [{ handler: "file_server", root: "/srv/help" }] }],
  errorRoutes: [{ handle: [{ handler: "static_response", status_code: 404 }] }],
};
const signal = new AbortController().signal;

function mockFetch(
  implementation: (...args: Parameters<typeof fetch>) => Promise<Response>,
) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(implementation, { preconnect: fetch.preconnect }),
  );
}

test("registers the site ahead of fallback routes without replacing other Caddy settings", async () => {
  const otherRoute = { handle: [{ handler: "static_response" }] };
  const otherError = {
    handle: [{ handler: "static_response", status_code: 500 }],
  };
  const settings = { listen: [":443"], protocols: ["h1", "h2"] };
  const plainHttp = { listen: [":80"] };
  const servers: Record<string, unknown> = {
    plainHttp,
    https: {
      ...settings,
      routes: [otherRoute],
      errors: { routes: [otherError] },
    },
  };
  const fetchMock = mockFetch(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(admin.url.origin);
    expect(init && "unix" in init ? init.unix : undefined).toBeUndefined();
    if (init?.method !== "PATCH") {
      expect(url.pathname).toBe(serverPath);
      return Response.json(servers, { headers: { etag } });
    }
    expect(url.pathname).toBe(`${serverPath}/https`);
    expect(new Headers(init.headers).get("if-match")).toBe(etag);
    servers.https = JSON.parse(String(init.body));
    return new Response();
  });
  try {
    expect(await ensureCaddySite(admin, site, undefined, signal)).toBe(true);
    expect(servers).toEqual({
      plainHttp,
      https: {
        ...settings,
        routes: [
          {
            "@id": "help-forum-generator",
            match: [{ host: [host] }],
            handle: [{ handler: "subroute", routes: site.routes }],
            terminal: true,
          },
          otherRoute,
        ],
        errors: {
          routes: [
            {
              "@id": "help-forum-generator-errors",
              match: [{ host: [host] }],
              handle: [{ handler: "subroute", routes: site.errorRoutes }],
            },
            otherError,
          ],
        },
      },
    });
    expect(await ensureCaddySite(admin, site, undefined, signal)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  } finally {
    fetchMock.mockRestore();
  }
});

test("refuses an existing unmanaged host route without sending a mutation", async () => {
  const fetchMock = mockFetch(async () =>
    Response.json(
      {
        https: { listen: [":443"] },
        other: {
          listen: [":8443"],
          routes: [{ match: [{ host: [host.toUpperCase() + "."] }] }],
        },
      },
      { headers: { etag } },
    ),
  );
  try {
    await expect(
      ensureCaddySite(admin, site, undefined, signal),
    ).rejects.toThrow("Caddy already has an unmanaged route");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    fetchMock.mockRestore();
  }
});

test("uses an explicitly selected listener and reports a rejected concurrent mutation", async () => {
  const fetchMock = mockFetch(async (input, init) => {
    if (init?.method !== "PATCH") {
      return Response.json(
        { custom: { listen: [":8443"] } },
        { headers: { etag } },
      );
    }
    expect(new URL(String(input)).pathname).toBe(`${serverPath}/custom`);
    expect(new Headers(init.headers).get("if-match")).toBe(etag);
    return new Response(null, { status: 412 });
  });
  try {
    await expect(
      ensureCaddySite(admin, site, "custom", signal),
    ).rejects.toThrow("Caddy configuration changed during site registration");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    fetchMock.mockRestore();
  }
});

test("reads and updates Caddy routes through a Unix socket", async () => {
  const unixAdmin: CaddyAdmin = {
    url: new URL("http://localhost"),
    socket: "/run/caddy/admin.sock",
  };
  const fetchMock = mockFetch(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(unixAdmin.url.origin);
    expect(init && "unix" in init ? init.unix : undefined).toBe(
      unixAdmin.socket,
    );
    expect(init?.redirect).toBe("error");
    if (init?.method !== "PATCH") {
      expect(url.pathname).toBe(serverPath);
      return Response.json(
        { https: { listen: [":443"] } },
        { headers: { etag } },
      );
    }
    expect(url.pathname).toBe(`${serverPath}/https`);
    expect(new Headers(init.headers).get("if-match")).toBe(etag);
    return new Response();
  });
  try {
    expect(await ensureCaddySite(unixAdmin, site, undefined, signal)).toBe(
      true,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    fetchMock.mockRestore();
  }
});
