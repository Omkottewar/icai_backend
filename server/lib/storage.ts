import { mkdir, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Thin abstraction over the bytes-on-disk operations the file pipeline needs.
// Two drivers ship today:
//
//   LocalDiskDriver     — writes to ./uploads/<bucket>/<file>, URL is /uploads/...
//   SupabaseDriver      — uploads to a Supabase Storage bucket, URL is the
//                         project's public Storage URL
//
// Driver selection is by env var (see `storage()` at the bottom). Callers
// never instantiate a driver directly.
//
// `storage_path` shape:  <bucket>/<filename>
// (so a "Supabase folder" structure is `<supabase-bucket>/<bucket>/<filename>`)

export interface StorageDriver {
  /**
   * Write `bytes` under `bucket/<filename>` and return the storage_path
   * that should be persisted on the files row. For the SupabaseDriver, the
   * returned path is the path *within* the configured Supabase bucket, so
   * the on-disk equivalent layout is preserved.
   */
  put(bucket: string, filename: string, bytes: Buffer, mimeType?: string): Promise<string>;

  /** Public URL the SPA can drop into an <img src>. */
  url(storagePath: string): string;

  /** Best-effort delete — failures swallowed. */
  remove(storagePath: string): Promise<void>;
}

const UPLOAD_DIR = "uploads";

class LocalDiskDriver implements StorageDriver {
  async put(bucket: string, filename: string, bytes: Buffer): Promise<string> {
    const dirAbs = join(process.cwd(), UPLOAD_DIR, bucket);
    if (!existsSync(dirAbs)) await mkdir(dirAbs, { recursive: true });
    await writeFile(join(dirAbs, filename), bytes);
    return `${bucket}/${filename}`;
  }

  url(storagePath: string): string {
    return `/uploads/${storagePath}`;
  }

  async remove(storagePath: string): Promise<void> {
    try {
      await unlink(join(process.cwd(), UPLOAD_DIR, storagePath));
    } catch {
      // Swallow ENOENT and friends — orphan row is gone, no integrity issue.
    }
  }
}

// ─── Supabase Storage driver ──────────────────────────────────────────────────
// Maps the existing `<bucket>/<filename>` layout into a single Supabase
// Storage bucket. The "bucket" arg from callers becomes a folder prefix
// inside the configured Supabase bucket, so paths stay byte-identical
// to the local layout and the backfill migration doesn't have to rewrite
// `files.storage_path`.
//
// Example: storage().put('gallery_photos', 'abc.webp', buf)
//   → uploaded to: <SUPABASE_BUCKET>/gallery_photos/abc.webp
//   → returned storage_path: gallery_photos/abc.webp
//   → URL:  https://<project>.supabase.co/storage/v1/object/public/<SUPABASE_BUCKET>/gallery_photos/abc.webp
//
// Public bucket assumed — we don't sign URLs. To support a private bucket
// later, route storage_path resolution through createSignedUrl with a TTL.

class SupabaseDriver implements StorageDriver {
  private client: SupabaseClient;
  private bucket: string;
  private publicUrlBase: string;

  constructor(url: string, serviceKey: string, bucket: string) {
    this.client = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });
    this.bucket = bucket;
    // Build the public URL prefix once. Format is stable:
    //   <project>/storage/v1/object/public/<bucket>/<path>
    this.publicUrlBase = `${url.replace(/\/+$/, "")}/storage/v1/object/public/${bucket}`;
  }

  async put(bucket: string, filename: string, bytes: Buffer, mimeType?: string): Promise<string> {
    const path = `${bucket}/${filename}`;
    const { error } = await this.client.storage.from(this.bucket).upload(
      path,
      bytes,
      {
        contentType: mimeType,
        upsert: true,
        cacheControl: "31536000",   // 1 year — bytes at <uuid>.<ext> are immutable
      },
    );
    if (error) {
      // Supabase's "Invalid path specified in request URL" almost always
      // means the bucket itself doesn't exist (their message is misleading).
      // Surface the supabase bucket + path we tried so the operator can spot
      // typos and missing buckets at a glance.
      const anyErr = error as { name?: string; statusCode?: string | number; message: string };
      const hint = /invalid path/i.test(anyErr.message)
        ? ` — does the Supabase bucket "${this.bucket}" exist and is it Public?`
        : "";
      throw new Error(
        `Supabase upload failed (bucket="${this.bucket}", path="${path}"): ${anyErr.message}${hint}`,
      );
    }
    return path;
  }

  url(storagePath: string): string {
    return `${this.publicUrlBase}/${storagePath}`;
  }

  async remove(storagePath: string): Promise<void> {
    try {
      await this.client.storage.from(this.bucket).remove([storagePath]);
    } catch {
      // Swallow — orphan in the bucket is fine.
    }
  }
}

// ─── Driver selection ─────────────────────────────────────────────────────────
// Supabase wins iff all three env vars are present. Otherwise local disk.
// The driver is constructed lazily on first call so a missing env var only
// matters for code paths that actually upload.
let _driver: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (_driver) return _driver;

  const rawUrl     = process.env.SUPABASE_URL;
  const supaKey    = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supaBucket = (process.env.SUPABASE_BUCKET ?? "public-content").trim();

  if (rawUrl && supaKey) {
    // The Supabase JS SDK expects the *project* URL only — it appends
    // /rest/v1/ for Postgres and /storage/v1/ for Storage internally. If
    // an operator pastes "https://<proj>.supabase.co/rest/v1/" (the
    // PostgREST URL shown in the dashboard's Project Settings → API page),
    // the SDK ends up building URLs like /rest/v1/storage/v1/... which
    // Supabase routes nowhere, yielding the confusing "Invalid path
    // specified in request URL" error on every upload. Strip any path
    // before handing the URL to createClient.
    const cleanedUrl = stripPathFromSupabaseUrl(rawUrl);
    if (cleanedUrl !== rawUrl) {
      // eslint-disable-next-line no-console
      console.warn(
        `[storage] SUPABASE_URL had a path/query — normalised "${rawUrl}" → "${cleanedUrl}". Update your .env to suppress this warning.`,
      );
    }
    _driver = new SupabaseDriver(cleanedUrl, supaKey, supaBucket);
    // eslint-disable-next-line no-console
    console.log(`[storage] Using Supabase Storage (bucket: ${supaBucket})`);
  } else {
    _driver = new LocalDiskDriver();
    // eslint-disable-next-line no-console
    console.log("[storage] Using local disk (./uploads). Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to switch.");
  }
  return _driver;
}

function stripPathFromSupabaseUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    // Keep protocol + host; drop pathname, search, hash.
    return `${u.protocol}//${u.host}`;
  } catch {
    // If URL parsing fails, fall back to a regex that strips everything
    // after the first single slash that's not part of "https://".
    return raw.trim().replace(/^(https?:\/\/[^/]+).*$/i, "$1");
  }
}
