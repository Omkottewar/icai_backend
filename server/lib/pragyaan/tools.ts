// Pragyaan AI — function-calling tools.
//
// Turns Pragyaan from a Q&A assistant into a portal *agent*: when the
// user asks "what events am I registered for?" the model can decide to
// call `my_registered_events()` and answer with live data instead of
// stale snapshots in kb_chunks.
//
// All tools here are READ-ONLY. Write actions (register-for-event,
// submit-grievance) are deliberately out of scope for v1 — they require
// confirmation UX that's better handled with explicit buttons in the
// chat surface rather than free-form LLM intent. Adding them is a
// separate change once the read tools are battle-tested.
//
// Each tool declares:
//   • name — what the model calls
//   • description — what the model reads to decide WHEN to call it
//   • parameters — JSON Schema; OpenAI enforces this on the model side
//   • requiresAuth — if true, an anon caller will never see the tool
//   • execute — runs server-side; returns plain JSON the model digests
//
// Security: tool visibility is gated by the caller's resolved scopes.
// `current_user_info` / `my_cpe_balance` / `my_registered_events` only
// appear in the schema we send to the model when there's an
// authenticated user — so the model can't call them anonymously and
// can't even mention them.

import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  events,
  eventRegistrations,
  committees,
  users,
  paperPresentations,
  branchNewsletters,
  announcements,
} from "../../../schema/index.js";
import type { KbScope } from "./scope.js";

export interface ToolContext {
  userId: string | null;
  scopes: Set<KbScope>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  requiresAuth: boolean;
  /** Run the tool. The return is JSON.stringified into the model's tool message. */
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

// ─── helpers ────────────────────────────────────────────────────────────────
//
// Format a date for the model. ISO is the safest format because the
// model is good at converting from ISO into a natural-language phrase
// in any language, but ISO is awkward to read raw. We pass both ISO
// and a human-friendly string.
function fmtDate(d: Date | string | null): { iso: string; readable: string } | null {
  if (!d) return null;
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return null;
  return {
    iso: date.toISOString(),
    readable: date.toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kolkata",
    }),
  };
}

// ─── tool definitions ───────────────────────────────────────────────────────

const list_upcoming_events: ToolDef = {
  name: "list_upcoming_events",
  description:
    "Lists upcoming branch events (CPE seminars, workshops, conferences). " +
    "Use this when the user asks about scheduled events, upcoming sessions, what's happening, or 'when is X'.",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        description: "How many events to return. Default 10, max 20.",
        minimum: 1,
        maximum: 20,
      },
      audience: {
        type: "string",
        enum: ["all", "members", "students"],
        description: "Optional audience filter. 'all' = no filter.",
      },
    },
  },
  requiresAuth: false,
  async execute(args) {
    const limit = Math.min(20, Math.max(1, Number(args.limit) || 10));
    const audience = String(args.audience ?? "all");
    const now = new Date();

    const conds: any[] = [
      gte(events.starts_at, now),
      eq(events.status, "published"),
      isNull(events.deleted_at),
    ];
    if (audience === "members" || audience === "students") {
      conds.push(eq(events.audience, audience));
    }

    const rows = await db
      .select({
        slug: events.slug,
        title: events.title,
        starts_at: events.starts_at,
        ends_at: events.ends_at,
        venue: events.venue,
        mode: events.mode,
        cpe_hours: events.cpe_hours,
        fee_paise: events.fee_paise,
        audience: events.audience,
        capacity: events.capacity,
        registered_count: events.registered_count,
        committee_name: committees.name,
      })
      .from(events)
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .where(and(...conds))
      .orderBy(asc(events.starts_at))
      .limit(limit);

    return {
      count: rows.length,
      events: rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        starts: fmtDate(r.starts_at),
        ends: fmtDate(r.ends_at),
        venue: r.venue,
        mode: r.mode,
        cpe_hours: r.cpe_hours,
        fee_inr: r.fee_paise / 100,
        audience: r.audience,
        committee: r.committee_name,
        seats_available: r.capacity != null ? r.capacity - r.registered_count : null,
      })),
    };
  },
};

const lookup_event: ToolDef = {
  name: "lookup_event",
  description:
    "Fetch full details for a single event by its slug. Slug is the URL-friendly identifier returned by list_upcoming_events.",
  parameters: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description: "The event slug (e.g. 'gst-workshop-aug-2026').",
      },
    },
    required: ["slug"],
  },
  requiresAuth: false,
  async execute(args) {
    const slug = String(args.slug ?? "").trim();
    if (!slug) return { error: "slug is required" };

    const [row] = await db
      .select({
        slug: events.slug,
        title: events.title,
        description: events.description,
        starts_at: events.starts_at,
        ends_at: events.ends_at,
        venue: events.venue,
        online_url: events.online_url,
        mode: events.mode,
        cpe_hours: events.cpe_hours,
        fee_paise: events.fee_paise,
        audience: events.audience,
        capacity: events.capacity,
        registered_count: events.registered_count,
        highlights: events.highlights,
        committee_name: committees.name,
      })
      .from(events)
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .where(and(eq(events.slug, slug), isNull(events.deleted_at)))
      .limit(1);

    if (!row) return { error: "no event found with that slug" };
    return {
      ...row,
      starts: fmtDate(row.starts_at),
      ends: fmtDate(row.ends_at),
      fee_inr: row.fee_paise / 100,
      seats_available: row.capacity != null ? row.capacity - row.registered_count : null,
      // The link the assistant should suggest if the user wants to act.
      detail_url: `/#/events/${row.slug}`,
    };
  },
};

const list_committees: ToolDef = {
  name: "list_committees",
  description:
    "Lists branch committees (GST, Direct Tax, IT, Audit, CPE, WICASA, etc.) with a short description of each.",
  parameters: { type: "object", properties: {} },
  requiresAuth: false,
  async execute() {
    const rows = await db
      .select({
        name: committees.name,
        code: committees.code,
        description: committees.description,
      })
      .from(committees)
      .where(eq(committees.active, true))
      .orderBy(asc(committees.name));
    return { count: rows.length, committees: rows };
  },
};

const current_user_info: ToolDef = {
  name: "current_user_info",
  description:
    "Returns the logged-in user's basic info (name, email, primary role). " +
    "Use this when the user asks 'who am I', 'what's my email', or to personalize a reply.",
  parameters: { type: "object", properties: {} },
  requiresAuth: true,
  async execute(_args, ctx) {
    if (!ctx.userId) return { error: "not authenticated" };
    const [row] = await db
      .select({
        name: users.name,
        email: users.email,
        primary_role: users.primary_role,
      })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);
    return row ?? { error: "user not found" };
  },
};

const my_registered_events: ToolDef = {
  name: "my_registered_events",
  description:
    "Lists upcoming events the logged-in user has registered for. " +
    "Use this when the user asks 'what am I registered for', 'my events', or wants their schedule.",
  parameters: {
    type: "object",
    properties: {
      include_past: {
        type: "boolean",
        description: "Include past events too. Default false (upcoming only).",
      },
    },
  },
  requiresAuth: true,
  async execute(args, ctx) {
    if (!ctx.userId) return { error: "not authenticated" };
    const includePast = !!args.include_past;
    const conds: any[] = [
      eq(eventRegistrations.user_id, ctx.userId),
      isNull(eventRegistrations.deleted_at),
      isNull(events.deleted_at),
    ];
    if (!includePast) conds.push(gte(events.ends_at, new Date()));

    const rows = await db
      .select({
        slug: events.slug,
        title: events.title,
        starts_at: events.starts_at,
        venue: events.venue,
        mode: events.mode,
        cpe_hours: events.cpe_hours,
        status: eventRegistrations.status,
      })
      .from(eventRegistrations)
      .innerJoin(events, eq(events.id, eventRegistrations.event_id))
      .where(and(...conds))
      .orderBy(asc(events.starts_at))
      .limit(50);

    return {
      count: rows.length,
      registrations: rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        starts: fmtDate(r.starts_at),
        venue: r.venue,
        mode: r.mode,
        cpe_hours: r.cpe_hours,
        registration_status: r.status,
      })),
    };
  },
};

const search_resources: ToolDef = {
  name: "search_resources",
  description:
    "Searches branch resources (paper presentations, newsletters, announcements) by keyword. " +
    "Returns up to 10 matching resources with titles and URLs. " +
    "Use this when the user is looking for a specific publication, paper, or past announcement.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords to search. Required.",
      },
    },
    required: ["query"],
  },
  requiresAuth: false,
  async execute(args) {
    const q = String(args.query ?? "").trim();
    if (!q || q.length < 2) return { error: "query must be at least 2 characters" };

    const like = `%${q}%`;
    const [papers, newsletters, announcementRows] = await Promise.all([
      db
        .select({
          title: paperPresentations.title,
          slug: paperPresentations.slug,
          speaker: paperPresentations.speaker_name,
          presented_on: paperPresentations.presented_on,
        })
        .from(paperPresentations)
        .where(and(
          eq(paperPresentations.status, "published"),
          eq(paperPresentations.hidden, false),
          sql`(${paperPresentations.title} ILIKE ${like} OR ${paperPresentations.abstract} ILIKE ${like})`,
        ))
        .limit(5),
      db
        .select({
          title: branchNewsletters.title,
          issue_year: branchNewsletters.issue_year,
          issue_month: branchNewsletters.issue_month,
        })
        .from(branchNewsletters)
        .where(sql`${branchNewsletters.title} ILIKE ${like}`)
        .orderBy(desc(branchNewsletters.issue_year), desc(branchNewsletters.issue_month))
        .limit(3),
      db
        .select({
          title: announcements.title,
          body: announcements.body,
          starts_at: announcements.starts_at,
        })
        .from(announcements)
        .where(and(
          isNull(announcements.deleted_at),
          sql`(${announcements.title} ILIKE ${like} OR ${announcements.body} ILIKE ${like})`,
        ))
        .orderBy(desc(announcements.starts_at))
        .limit(3),
    ]);

    return {
      papers: papers.map((p) => ({
        title: p.title,
        speaker: p.speaker,
        presented_on: fmtDate(p.presented_on),
        url: `/#/resources/papers/${p.slug}`,
      })),
      newsletters: newsletters.map((n) => ({
        title: n.title,
        issue: `${n.issue_month}/${n.issue_year}`,
      })),
      announcements: announcementRows.map((a) => ({
        title: a.title,
        snippet: (a.body || "").slice(0, 220),
        posted: fmtDate(a.starts_at),
      })),
    };
  },
};

// All available tools — visible_for_context() prunes by auth state.
const ALL_TOOLS: ToolDef[] = [
  list_upcoming_events,
  lookup_event,
  list_committees,
  current_user_info,
  my_registered_events,
  search_resources,
];

const TOOL_INDEX: Map<string, ToolDef> = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/**
 * Return the tools an authenticated/anonymous caller may see.
 * Tools with requiresAuth=true are hidden from anonymous callers so the
 * model can't even mention them.
 */
export function toolsForContext(ctx: ToolContext): ToolDef[] {
  if (ctx.userId) return ALL_TOOLS;
  return ALL_TOOLS.filter((t) => !t.requiresAuth);
}

/**
 * Render the tool list into the OpenAI function-calling JSON shape.
 * Matches the `tools` parameter on `chat.completions.create`.
 */
export function toolSchemasFor(ctx: ToolContext): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return toolsForContext(ctx).map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Execute a tool call. Enforces auth: even if a model somehow asks for
 * an auth-only tool while ctx.userId is null, we reject. JSON-stringifies
 * the result; if the tool throws, returns a stringified error so the
 * model can recover gracefully.
 */
export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<string> {
  const tool = TOOL_INDEX.get(name);
  if (!tool) {
    return JSON.stringify({ error: `unknown tool: ${name}` });
  }
  if (tool.requiresAuth && !ctx.userId) {
    return JSON.stringify({ error: "this tool requires the user to be logged in" });
  }
  let args: Record<string, unknown> = {};
  try { args = rawArgs ? JSON.parse(rawArgs) : {}; }
  catch { return JSON.stringify({ error: "invalid tool arguments JSON" }); }

  try {
    const result = await tool.execute(args, ctx);
    return JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message || "tool failed" });
  }
}
