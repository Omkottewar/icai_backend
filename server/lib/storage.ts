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
    if (error) throw new Error(`Supabase upload failed: ${error.message}`);
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

  const supaUrl    = process.env.SUPABASE_URL;
  const supaKey    = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supaBucket = process.env.SUPABASE_BUCKET ?? "public-content";

  if (supaUrl && supaKey) {
    _driver = new SupabaseDriver(supaUrl, supaKey, supaBucket);
    // eslint-disable-next-line no-console
    console.log(`[storage] Using Supabase Storage (bucket: ${supaBucket})`);
  } else {
    _driver = new LocalDiskDriver();
    // eslint-disable-next-line no-console
    console.log("[storage] Using local disk (./uploads). Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to switch.");
  }
  return _driver;
}
