export type RenderAssets = {
  get(path: string): boolean;
  add(path: string, bytes: Uint8Array): void;
};

const DISCORD_MEDIA = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
  "images-ext-1.discordapp.net",
  "images-ext-2.discordapp.net",
]);
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const ASSET_TIMEOUT_MS = 45_000;
const DOWNLOAD_CONCURRENCY = 3;

export function webUrl(value: string): URL | null {
  if (!/^https?:\/\//i.test(value) || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.username || url.password ? null : url;
}

export function discordMedia(value: string): URL | null {
  const url = webUrl(value);
  return url?.protocol === "https:" &&
    !url.port &&
    DISCORD_MEDIA.has(url.hostname)
    ? url
    : null;
}

export function assetUrl(path: string): string {
  return "../../" + path;
}

async function download(
  url: URL,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const timeout = AbortSignal.timeout(ASSET_TIMEOUT_MS);
  const response = await fetch(url, {
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    if (response.status === 429 || response.status >= 500) {
      throw new Error(
        `Discord media request failed with HTTP ${response.status}`,
      );
    }
    return null;
  }
  if (Number(response.headers.get("content-length")) > MAX_ASSET_BYTES) {
    await response.body.cancel();
    return null;
  }

  const parts: Uint8Array[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ASSET_BYTES) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return size ? new Uint8Array(Bun.concatArrayBuffers(parts)) : null;
}

export class ThreadAssets {
  readonly paths = new Set<string>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly waiting: Array<() => void> = [];
  private downloading = 0;

  constructor(
    private readonly storage: RenderAssets,
    private readonly signal?: AbortSignal,
  ) {}

  async localize(
    source: string,
    directory: string,
    extension: string,
  ): Promise<string | null> {
    const url = discordMedia(source);
    if (!url) return null;

    // CDN attachment signatures change every time Discord refreshes them.
    const key =
      url.origin +
      url.pathname +
      (/^\/(?:ephemeral-)?attachments\//.test(url.pathname) ? "" : url.search);
    const hash = new Bun.CryptoHasher("sha256").update(key).digest("hex");
    const path = `assets/${directory}/${hash}.${extension}`;
    let result = this.pending.get(path);
    if (!result) {
      result = this.resolve(url, path);
      this.pending.set(path, result);
    }
    return result;
  }

  private async resolve(url: URL, path: string): Promise<string | null> {
    if (!this.storage.get(path)) {
      let bytes: Uint8Array | null;
      try {
        bytes = await this.load(url);
      } catch (error) {
        if (this.signal?.aborted) this.signal.throwIfAborted();
        // Fetch errors may include the temporary signed URL.
        throw new Error(
          `Could not download a Discord asset (${url.hostname})`,
          {
            cause: error instanceof Error ? error.name : undefined,
          },
        );
      }
      if (!bytes) return null;
      this.storage.add(path, bytes);
    }
    this.paths.add(path);
    return path;
  }

  private async load(url: URL): Promise<Uint8Array | null> {
    if (this.downloading < DOWNLOAD_CONCURRENCY) {
      this.downloading++;
    } else {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      this.signal?.throwIfAborted();
      return await download(url, this.signal);
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.downloading--;
    }
  }
}

const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/aac": "aac",
  "audio/flac": "flac",
};

const IMAGE = /^(?:png|jpe?g|gif|webp|avif|bmp)$/;
const VIDEO = /^(?:mp4|m4v|webm|mov)$/;
const AUDIO = /^(?:mp3|m4a|wav|ogg|aac|flac)$/;

export function mediaFile(source: string, contentType?: string | null) {
  const suffix = webUrl(source)
    ?.pathname.match(/\.([a-z0-9]+)$/i)?.[1]
    ?.toLowerCase();
  const extension = contentType
    ? (MEDIA_EXTENSIONS[
        contentType.split(";")[0]?.trim().toLowerCase() ?? ""
      ] ?? "bin")
    : (suffix ?? "");
  if (IMAGE.test(extension)) return { extension, kind: "image" as const };
  if (VIDEO.test(extension)) return { extension, kind: "video" as const };
  if (AUDIO.test(extension)) return { extension, kind: "audio" as const };
  return { extension: "bin", kind: "file" as const };
}
