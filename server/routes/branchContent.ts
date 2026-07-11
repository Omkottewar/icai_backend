import { Router } from "express";
import { aliasedTable, and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  paperPresentations,
  galleryAlbums,
  galleryPhotos,
  galleryVideos,
  branchNewsletters,
  officeBearers,
  annualReports,
  files,
  events,
  users,
} from "../../schema/index.js";
import { ApiError, handleApiError, trim } from "../lib/apiError.js";
import { storage } from "../lib/storage.js";

// One public router for everything you find under "Resources", "Gallery",
// and the bottom of the About page. All endpoints filter hidden=false; the
// admin equivalent at /api/admin/* sees everything.

export const branchContentRouter = Router();

// Build the public URL for a stored file. Goes through the storage driver
// so the same code works against local disk (returns `/uploads/...`) or
// Supabase Storage (returns the public bucket URL).
const fileUrl = (path: string | null) => (path ? storage().url(path) : null);

// ─── Paper Presentations ─────────────────────────────────────────────────────
// Used by ResourcesPage. Returns each card's PDF + speaker + committee tag.
// Filters on hidden=false; admins can still see hidden rows in the admin UI.
branchContentRouter.get("/paper-presentations", async (_req, res, next) => {
  try {
    const rows = await db.select({
      id:           paperPresentations.id,
      slug:         paperPresentations.slug,
      title:        paperPresentations.title,
      speaker_name: paperPresentations.speaker_name,
      committee_tag: paperPresentations.committee_tag,
      presented_on: paperPresentations.presented_on,
      description:  paperPresentations.description,
      event_title:  events.title,
      pdf_path:     files.storage_path,
      pdf_name:     files.name,
    })
      .from(paperPresentations)
      .leftJoin(files, eq(files.id, paperPresentations.pdf_file_id))
      .leftJoin(events, eq(events.id, paperPresentations.event_id))
      // hidden=false AND status='published' so member-submitted drafts /
      // rejected entries don't surface on the public Resources page.
      .where(and(
        eq(paperPresentations.hidden, false),
        eq(paperPresentations.status, "published"),
      ))
      .orderBy(asc(paperPresentations.sort_order), desc(paperPresentations.presented_on));

    res.json({
      items: rows.map((r) => ({
        ...r,
        pdf_url: fileUrl(r.pdf_path),
      })),
    });
  } catch (err) { next(err); }
});

// ─── Best Paper Winner ───────────────────────────────────────────────────────
// Returns the single most-recent winning paper (highest award_year with
// is_winner=true). The HomePage's BestPaperShowcase queries this on
// every load — cached by the frontend's apiCache so the homepage stays
// fast. 404 when no winner has been flagged yet, so the frontend can
// hide the section entirely.
branchContentRouter.get("/paper-presentations/best-paper", async (_req, res, next) => {
  try {
    const [row] = await db.select({
      id:                paperPresentations.id,
      slug:              paperPresentations.slug,
      title:             paperPresentations.title,
      abstract:          paperPresentations.abstract,
      description:       paperPresentations.description,
      speaker_name:      paperPresentations.speaker_name,
      author_designation: paperPresentations.author_designation,
      author_name:       users.name,
      author_avatar_id:  users.avatar_id,
      committee_tag:     paperPresentations.committee_tag,
      presented_on:      paperPresentations.presented_on,
      award_year:        paperPresentations.award_year,
      pdf_path:          files.storage_path,
      pdf_name:          files.name,
    })
      .from(paperPresentations)
      .leftJoin(files, eq(files.id, paperPresentations.pdf_file_id))
      .leftJoin(users, eq(users.id, paperPresentations.author_user_id))
      .where(and(
        eq(paperPresentations.is_winner, true),
        eq(paperPresentations.hidden, false),
        eq(paperPresentations.status, "published"),
      ))
      .orderBy(desc(paperPresentations.award_year))
      .limit(1);

    if (!row) return res.status(404).json({ error: "no_winner_yet" });

    res.json({
      ...row,
      pdf_url: fileUrl(row.pdf_path),
    });
  } catch (err) { next(err); }
});

// ─── Photo Gallery ───────────────────────────────────────────────────────────
// List albums (with cover thumbnail + photo count). Three-tier visibility:
//   public  → anyone
//   members → only when the request carries a session cookie
//   private → admin-only; never shown on these public endpoints
branchContentRouter.get("/gallery-albums", async (req, res, next) => {
  try {
    const isLoggedIn = !!req.cookies?.session;
    const allowedVis = isLoggedIn ? ["public", "members"] : ["public"];

    const rows = await db.select({
      id:           galleryAlbums.id,
      title:        galleryAlbums.title,
      committee_tag: galleryAlbums.committee_tag,
      event_type:    galleryAlbums.event_type,
      occurred_on:  galleryAlbums.occurred_on,
      description:  galleryAlbums.description,
      visibility:   galleryAlbums.visibility,
      is_featured:       galleryAlbums.is_featured,
      featured_position: galleryAlbums.featured_position,
      layout:            galleryAlbums.layout,
      cover_path:        files.storage_path,
      cover_thumb_path:  files.thumb_path,
      cover_medium_path: files.medium_path,
      cover_alt:         files.alt_text,
    })
      .from(galleryAlbums)
      .leftJoin(files, eq(files.id, galleryAlbums.cover_file_id))
      .where(and(
        eq(galleryAlbums.hidden, false),
        inArray(galleryAlbums.visibility, allowedVis),
      ))
      .orderBy(asc(galleryAlbums.sort_order), desc(galleryAlbums.occurred_on));

    // Photo counts via a second query — kept separate from the album list
    // so the main page load stays a simple flat select.
    const counts = await db.select({
      album_id: galleryPhotos.album_id,
      count:    sql<number>`count(*)::int`.as("count"),
    })
      .from(galleryPhotos)
      .groupBy(galleryPhotos.album_id);
    const countByAlbum = new Map<string, number>(counts.map((c) => [c.album_id, c.count]));

    // We send featured (hero strip) and items (everything below) as two
    // arrays so the frontend doesn't have to filter twice. Featured albums
    // STAY in `items` too — the page still wants them findable by the
    // committee filter chips below the hero.
    const shape = (r: typeof rows[number]) => ({
      id: r.id,
      title: r.title,
      committee_tag: r.committee_tag,
      event_type: r.event_type,
      occurred_on: r.occurred_on,
      description: r.description,
      visibility: r.visibility,
      is_featured: r.is_featured,
      featured_position: r.featured_position,
      layout: r.layout || "grid",
      cover_url:        fileUrl(r.cover_path),
      cover_thumb_url:  fileUrl(r.cover_thumb_path)  ?? fileUrl(r.cover_path),
      cover_medium_url: fileUrl(r.cover_medium_path) ?? fileUrl(r.cover_path),
      cover_alt:        r.cover_alt ?? "",
      photo_count: countByAlbum.get(r.id) ?? 0,
    });

    const items = rows.map(shape);
    const featured = items
      .filter((a) => a.is_featured && a.featured_position)
      .sort((a, b) => (a.featured_position ?? 99) - (b.featured_position ?? 99));

    res.json({ items, featured });
  } catch (err) { next(err); }
});

// One album with its photos. Used by the gallery lightbox.
branchContentRouter.get("/gallery-albums/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const isLoggedIn = !!req.cookies?.session;
    const allowedVis = isLoggedIn ? ["public", "members"] : ["public"];
    const coverFiles = aliasedTable(files, "cover_files");

    const [album] = await db.select({
      id:           galleryAlbums.id,
      title:        galleryAlbums.title,
      committee_tag: galleryAlbums.committee_tag,
      occurred_on:  galleryAlbums.occurred_on,
      description:  galleryAlbums.description,
      visibility:   galleryAlbums.visibility,
      layout:       galleryAlbums.layout,
      cover_path:        coverFiles.storage_path,
      cover_thumb_path:  coverFiles.thumb_path,
      cover_medium_path: coverFiles.medium_path,
    })
      .from(galleryAlbums)
      .leftJoin(coverFiles, eq(coverFiles.id, galleryAlbums.cover_file_id))
      .where(and(
        eq(galleryAlbums.id, id),
        eq(galleryAlbums.hidden, false),
        inArray(galleryAlbums.visibility, allowedVis),
      ));

    if (!album) throw new ApiError(404, "Album not found");

    const photos = await db.select({
      id:           galleryPhotos.id,
      caption:      galleryPhotos.caption,
      sort_order:   galleryPhotos.sort_order,
      is_featured:  galleryPhotos.is_featured,
      path:         files.storage_path,
      thumb_path:   files.thumb_path,
      medium_path:  files.medium_path,
      width:        files.width,
      height:       files.height,
      alt_text:     files.alt_text,
    })
      .from(galleryPhotos)
      .leftJoin(files, eq(files.id, galleryPhotos.file_id))
      .where(eq(galleryPhotos.album_id, id))
      .orderBy(asc(galleryPhotos.sort_order));

    res.json({
      album: {
        ...album,
        layout: album.layout || "grid",
        cover_url:        fileUrl(album.cover_path),
        cover_thumb_url:  fileUrl(album.cover_thumb_path)  ?? fileUrl(album.cover_path),
        cover_medium_url: fileUrl(album.cover_medium_path) ?? fileUrl(album.cover_path),
      },
      photos: photos.map((p) => ({
        id:        p.id,
        caption:   p.caption,
        sort_order: p.sort_order,
        is_featured: p.is_featured,
        url:       fileUrl(p.path),
        thumb_url: fileUrl(p.thumb_path)  ?? fileUrl(p.path),
        medium_url: fileUrl(p.medium_path) ?? fileUrl(p.path),
        width:     p.width,
        height:    p.height,
        alt:       p.alt_text ?? '',
      })),
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── ZIP download for an album ─────────────────────────────────────────────────
// Streams a zip of all originals in an album. Same visibility rules as the
// list endpoint — public/members tiers gated by the session cookie.
branchContentRouter.get("/gallery-albums/:id/download.zip", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const isLoggedIn = !!req.cookies?.session;
    const allowedVis = isLoggedIn ? ["public", "members"] : ["public"];

    const [album] = await db.select({
      id:    galleryAlbums.id,
      title: galleryAlbums.title,
    })
      .from(galleryAlbums)
      .where(and(
        eq(galleryAlbums.id, id),
        eq(galleryAlbums.hidden, false),
        inArray(galleryAlbums.visibility, allowedVis),
      ));
    if (!album) throw new ApiError(404, "Album not found");

    const photos = await db.select({
      file_name: files.name,
      file_path: files.storage_path,
    })
      .from(galleryPhotos)
      .leftJoin(files, eq(files.id, galleryPhotos.file_id))
      .where(eq(galleryPhotos.album_id, id))
      .orderBy(asc(galleryPhotos.sort_order));

    // archiver dynamic-import keeps it out of cold-start memory for every
    // other request — only this endpoint ever needs it.
    const archiver = (await import("archiver")) as unknown as typeof import("archiver");
    const archiverFn = (archiver as any).default ?? archiver;

    const safeName = (album.title || "album").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.zip"`);

    const archive = archiverFn("zip", { zlib: { level: 6 } });
    archive.on("error", (e: Error) => next(e));
    archive.pipe(res);

    // Fetch each photo from the storage driver's public URL. Works for both
    // local disk (loopback to /uploads via fetch) and Supabase (the public
    // URL is the bucket URL). For local-disk the loopback adds a tiny hop
    // but avoids embedding path knowledge here.
    for (const p of photos) {
      if (!p.file_path) continue;
      const url = storage().url(p.file_path);
      const absoluteUrl = url.startsWith("http") ? url : `http://localhost:${process.env.PORT ?? 4000}${url}`;
      try {
        const r = await fetch(absoluteUrl);
        if (!r.ok || !r.body) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        archive.append(buf, { name: p.file_name || p.file_path.split("/").pop()! });
      } catch {
        // Individual photo fetch failure — skip, finish the rest.
      }
    }
    await archive.finalize();
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Video Gallery ───────────────────────────────────────────────────────────
// List videos with optional ?committee= / ?event_type= / ?year= filters.
// Same visibility tiers as photo albums (public / members / private).
branchContentRouter.get("/gallery-videos", async (req, res, next) => {
  try {
    const isLoggedIn = !!req.cookies?.session;
    const allowedVis = isLoggedIn ? ["public", "members"] : ["public"];

    const rows = await db.select({
      id:            galleryVideos.id,
      title:         galleryVideos.title,
      description:   galleryVideos.description,
      provider:      galleryVideos.provider,
      video_id:      galleryVideos.video_id,
      video_url:     galleryVideos.video_url,
      committee_tag: galleryVideos.committee_tag,
      event_type:    galleryVideos.event_type,
      occurred_on:   galleryVideos.occurred_on,
      duration_secs: galleryVideos.duration_secs,
      is_featured:   galleryVideos.is_featured,
      sort_order:    galleryVideos.sort_order,
      poster_path:        files.storage_path,
      poster_thumb_path:  files.thumb_path,
      poster_medium_path: files.medium_path,
    })
      .from(galleryVideos)
      .leftJoin(files, eq(files.id, galleryVideos.poster_file_id))
      .where(and(
        eq(galleryVideos.hidden, false),
        inArray(galleryVideos.visibility, allowedVis),
      ))
      .orderBy(asc(galleryVideos.sort_order), desc(galleryVideos.occurred_on));

    res.json({
      items: rows.map((r) => ({
        id:            r.id,
        title:         r.title,
        description:   r.description,
        provider:      r.provider,
        video_id:      r.video_id,
        video_url:     r.video_url,
        committee_tag: r.committee_tag,
        event_type:    r.event_type,
        occurred_on:   r.occurred_on,
        duration_secs: r.duration_secs,
        is_featured:   r.is_featured,
        poster_url:        fileUrl(r.poster_path),
        poster_thumb_url:  fileUrl(r.poster_thumb_path)  ?? fileUrl(r.poster_path),
        poster_medium_url: fileUrl(r.poster_medium_path) ?? fileUrl(r.poster_path),
      })),
    });
  } catch (err) { next(err); }
});

// ─── Newsletters ─────────────────────────────────────────────────────────────
branchContentRouter.get("/newsletters", async (_req, res, next) => {
  try {
    const coverFiles = aliasedTable(files, "cover_files");

    const rows = await db.select({
      id:          branchNewsletters.id,
      title:       branchNewsletters.title,
      issue_month: branchNewsletters.issue_month,
      issue_year:  branchNewsletters.issue_year,
      editor_note: branchNewsletters.editor_note,
      published_at: branchNewsletters.published_at,
      pdf_path:    files.storage_path,
      cover_path:  coverFiles.storage_path,
    })
      .from(branchNewsletters)
      .leftJoin(files, eq(files.id, branchNewsletters.pdf_file_id))
      .leftJoin(coverFiles, eq(coverFiles.id, branchNewsletters.cover_file_id))
      .where(eq(branchNewsletters.hidden, false))
      .orderBy(desc(branchNewsletters.issue_year), desc(branchNewsletters.issue_month));

    res.json({
      items: rows.map((r) => ({
        ...r,
        pdf_url:   fileUrl(r.pdf_path),
        cover_url: fileUrl(r.cover_path),
      })),
    });
  } catch (err) { next(err); }
});

// ─── Office Bearers + Past Chairmen ──────────────────────────────────────────
// Three view modes via ?view=:
//   view=current    → only is_current=true rows (Managing Committee)
//   view=chairmen   → all role_code='chairman' rows (Past Chairmen archive)
//   view=all (default) → everything not hidden
branchContentRouter.get("/office-bearers", async (req, res, next) => {
  try {
    const view = trim(req.query.view);

    const conds = [eq(officeBearers.hidden, false)];
    if (view === "current")  conds.push(eq(officeBearers.is_current, true));
    if (view === "chairmen") conds.push(eq(officeBearers.role_code, "chairman"));

    const rows = await db.select({
      id:           officeBearers.id,
      term_label:   officeBearers.term_label,
      role_label:   officeBearers.role_label,
      role_code:    officeBearers.role_code,
      person_name:  officeBearers.person_name,
      bio:          officeBearers.bio,
      email:        officeBearers.email,
      phone:        officeBearers.phone,
      tenure_start: officeBearers.tenure_start,
      tenure_end:   officeBearers.tenure_end,
      photo_path:   files.storage_path,
    })
      .from(officeBearers)
      .leftJoin(files, eq(files.id, officeBearers.photo_file_id))
      .where(and(...conds))
      .orderBy(desc(officeBearers.term_label), asc(officeBearers.sort_order));

    res.json({
      items: rows.map((r) => ({
        ...r,
        photo_url: fileUrl(r.photo_path),
      })),
    });
  } catch (err) { next(err); }
});

// ─── Annual Reports ──────────────────────────────────────────────────────────
branchContentRouter.get("/annual-reports", async (_req, res, next) => {
  try {
    const coverFiles = aliasedTable(files, "cover_files");

    const rows = await db.select({
      id:          annualReports.id,
      fy_label:    annualReports.fy_label,
      title:       annualReports.title,
      summary:     annualReports.summary,
      published_at: annualReports.published_at,
      pdf_path:    files.storage_path,
      cover_path:  coverFiles.storage_path,
    })
      .from(annualReports)
      .leftJoin(files, eq(files.id, annualReports.pdf_file_id))
      .leftJoin(coverFiles, eq(coverFiles.id, annualReports.cover_file_id))
      .where(eq(annualReports.hidden, false))
      .orderBy(desc(annualReports.fy_label));

    res.json({
      items: rows.map((r) => ({
        ...r,
        pdf_url:   fileUrl(r.pdf_path),
        cover_url: fileUrl(r.cover_path),
      })),
    });
  } catch (err) { next(err); }
});
