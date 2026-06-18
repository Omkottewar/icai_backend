# Pragyaan AI — Technical Spec (FIN-151)

Single source of truth for the role-aware RAG assistant build. All implementation
agents MUST read this before writing code, and MUST match existing codebase
conventions (read neighbouring files first).

> Spelling is **Pragyaan** (canonical). Frontend currently uses "PrayGyaan" — rename to Pragyaan.

## Stack & conventions (do not deviate)
- Backend: `D:/Documents/ICAI/backend` — Express 4, Drizzle ORM + postgres-js, TypeScript run via `tsx` (ESM, `"type":"module"`). DB client: `db/client.ts` (singleton `db`, `prepare:false`). Errors via `server/lib/apiError.ts` (`ApiError`). Routes are flat under `server/routes/`, registered in `server/index.ts`. Auth middleware: `server/middleware/{requireUser,requireAdmin,requireRole}.ts`. Permissions: `server/auth/permissions.ts` → `loadUserPermissions(userId)`.
- Frontend: `D:/Documents/ICAI/frontend` — Vite + React (JS), hash router (`src/hooks/useRoute.js`, `src/router/AppShell.jsx`), auth via `src/context/AuthContext.jsx` (`useAuth()`) + `src/hooks/useRoleFlags.js`. API calls: raw `fetch` with `credentials:'include'`; GET cache wrapper `src/lib/apiCache.js`. `/api` is proxied to `:4000`.
- **Agents must NOT**: run `db:migrate`/`db:push` against the live DB, run `git push`, install packages unless told. Write migration FILES only; the human applies them.

## Environment additions (add to `.env` and `.env.example`)
```
OPENAI_CHAT_MODEL=          # latest BUDGET model (GPT-5.x mini/nano tier) — set before launch
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
PRAGYAAN_TOP_K=6
PRAGYAAN_MIN_SIMILARITY=0.18   # cosine similarity floor; below ⇒ no-answer
PRAGYAAN_MAX_CONTEXT_CHARS=12000
PRAGYAAN_ANON_RATE_PER_MIN=8
PRAGYAAN_USER_RATE_PER_MIN=30
```
`OPENAI_API_KEY` already exists (currently blank → dev-echo mode).

## Provider abstraction (`server/lib/pragyaan/provider.ts` + `config.ts`)
Interface:
```ts
interface PragyaanProvider {
  embedTexts(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  generateStream(messages: ChatMsg[], opts?: {maxTokens?: number}): AsyncIterable<{delta?: string; usage?: {in: number; out: number}}>;
  readonly mode: 'openai' | 'dev-echo';
  readonly chatModel: string;
}
```
- **OpenAIProvider**: uses the `openai` SDK. Embeddings via `OPENAI_EMBEDDING_MODEL` with `dimensions=EMBEDDING_DIMENSIONS`. Generation via `OPENAI_CHAT_MODEL`, streamed.
- **DevEchoProvider** (when `OPENAI_API_KEY` blank): deterministic hash-based pseudo-embeddings of the configured dimension (stable per input text), and a canned grounded answer that extracts/quotes the supplied context (or the no-answer line if none). Logs once at startup: `Pragyaan: DEV-ECHO mode (set OPENAI_API_KEY for real answers)`.
- `getProvider()` selects by env and is a module singleton.

## Role → scope policy (security-critical, P0-3)
Scopes enum (`kb_scope`): `public | member | student | employer | internal`.
`rolesToScopes(perms, primaryRole)` → `Set<kb_scope>`:
- No session (visitor) → `{public}`
- `primary_role==='student'` (and not internal) → `{public, student}`
- `primary_role==='employer'` → `{public, employer}`
- `primary_role==='member'` → `{public, member}`  ← **NEVER** `internal`
- **Internal** (perms.isAdmin OR any active role assignment in the roles taxonomy — branch_*, mcm, committee_*, branch_manager, staff/employee primary_role) → ALL scopes `{public, member, student, employer, internal}`
Enforcement is at **retrieval**: the SQL `WHERE scope = ANY(:scopes)` filters before generation, so gated chunks never enter the LLM context. Determine role server-side only (session/`loadUserPermissions`), never trust a client-supplied role.

## Data model
Migration `0037_pragyaan_kb.sql` (APPLIED): `kb_sources`, `kb_chunks` (vector(1536)+HNSW), `kb_conversations`, `kb_messages`. Drizzle models in `schema/pragyaan.ts`.
Migration `0038_pragyaan_governance.sql` (TO WRITE): `kb_feedback` (message_id, rating up/down, comment, user_id, created_at), `kb_audit` (append-only, hash-chained: id, source_id, actor_id, action, from_version, to_version, detail jsonb, prev_hash, row_hash, created_at), `kb_query_log` (conversation_id, question, lang, role_label, scope_set, no_answer bool, top_similarity, citation_count, model, created_at) for analytics. Add matching Drizzle models to `schema/pragyaan.ts` and export.

## Retrieval (`server/lib/pragyaan/retrieval.ts`)
1. `embedQuery(question)`.
2. SQL ANN search (raw `db.execute(sql\`...\`)`):
   `SELECT c.id, c.content, c.source_id, c.scope, c.chunk_index, s.title, s.url, s.origin_kind, s.origin_id, 1 - (c.embedding <=> :qvec) AS similarity FROM kb_chunks c JOIN kb_sources s ON s.id=c.source_id WHERE c.scope = ANY(:scopes) AND c.embedding IS NOT NULL AND s.status='indexed' AND s.retired_at IS NULL AND s.approved_at IS NOT NULL AND (s.retention_expires_at IS NULL OR s.retention_expires_at > now()) ORDER BY c.embedding <=> :qvec LIMIT :k`.
   (pgvector literal format: `'[v1,v2,...]'`.)
3. If top similarity < `PRAGYAAN_MIN_SIMILARITY` ⇒ `noAnswer=true`.

## Orchestration (`server/lib/pragyaan/{prompt,answer}.ts`)
- System prompt: identity (Pragyaan, ICAI Nagpur Branch assistant), STRICT grounding ("Answer ONLY from the numbered SOURCES. If the answer isn't in them, say you don't know and, if the topic looks gated, suggest logging in — never fabricate"), citation rule (cite `[n]`), language rule (reply in the user's language: English/Hindi/Marathi), brevity, disclaimer awareness.
- Context: numbered sources `[n] <title>\n<content>`; cap at `PRAGYAAN_MAX_CONTEXT_CHARS`.
- Stream tokens; assemble `citations` from the retrieved sources actually referenced (default: all provided, deduped by source). On no-answer, return the localized "I don't know / try X" message and `citations=[]`.
- Log: upsert `kb_conversations`, insert user + assistant `kb_messages` (citations, model, tokens, latency), insert `kb_query_log` row.

## Multilingual (P0-7)
`lang` from client param if given, else detect (Devanagari script ⇒ hi default, allow mr; else en). Instruct model to answer in that language. Cross-lingual retrieval relies on the multilingual embedding (no translation needed v1). Store `lang` on conversation/messages.

## API contract
Public (anon allowed) — `server/routes/pragyaan.ts`, mounted `/api/pragyaan`:
- `POST /chat` — body `{message, conversationId?, anonId?, lang?}`. **Streamed** response (`Content-Type: text/event-stream`; frames: `event: token data:{delta}`, then `event: done data:{conversationId,messageId,citations,noAnswer}`). Rate-limited (anon by IP `PRAGYAAN_ANON_RATE_PER_MIN`, authed `PRAGYAAN_USER_RATE_PER_MIN`) via `express-rate-limit`.
- `GET /starters` — role-based suggested questions (static map by role; no table). (P1-2)
- `GET /conversations/:id` — history; visible to owner (user_id match) or matching anon_id. (P1-3)
- `POST /feedback` — `{messageId, rating:'up'|'down', comment?}` → `kb_feedback`. (P1-1)
- `GET /config` — disclaimer text + supported languages.
Admin — `server/routes/admin/pragyaan.ts`, mounted under `/api/admin/pragyaan` (requireUser+requireAdmin; governance endpoints also allow chairman via `requireRole`):
- `POST /sources` (create: file_id|url|text + scope + lang + source_type) → enqueue ingest. (P0-5)
- `GET /sources` (list: status, scope, version, chunk count) ; `GET /sources/:id` (detail+version chain).
- `POST /sources/:id/reindex` ; `POST /sources/:id/rollback` (revert via `supersedes_id` chain) ; `POST /sources/:id/retire`.
- `POST /ingest/public` (trigger public corpus job). (P0-4)
- `GET /approvals` (pending queue) ; `POST /sources/:id/approve` ; `POST /sources/:id/reject` (chairman; uses existing `approvals` table `target_type='kb_source'`). (P0-6)
- `PATCH /sources/:id/retention` (set `retention_expires_at`). (P0-6)
- `GET /feedback` (answer-quality review queue). (P1-1)
- `GET /analytics` (volume, no-answer rate, top questions, deflection signal). (P1-5)
Every source mutation (upload/approve/reject/reindex/rollback/retire/retention) writes a `kb_audit` row. (P0-8)

## Governance gating
A source is retrievable only when `status='indexed' AND approved_at IS NOT NULL AND retired_at IS NULL AND retention not expired`.
- **Public corpus** ingested via `/ingest/public` is **system-auto-approved** (set `approved_at=now()`, approver=system) so the launch (visitor) scope answers immediately.
- **Admin-uploaded** sources start unapproved ⇒ require chairman approve before answers use them.

## Ingestion (`server/lib/pragyaan/ingest.ts` + `scripts/ingest-public.mjs`)
- Public corpus (scope=public): pull live rows from existing tables → build text docs → upsert `kb_sources` (origin_kind/origin_id, checksum) → chunk → embed → insert `kb_chunks` → status `indexed`, auto-approved. Sources: published events, circulars, standards refs, FAQs, `site_content`, branch/about, public initiative pages, branch_newsletters/annual_reports/paper_presentations (PDF text). Skip unchanged (checksum). Re-runnable.
- PDF text extraction: add `pdf-parse` (human installs) — agents write code guarded so missing dep degrades gracefully.
- Chunker: ~800 tokens (~3200 chars) with ~100-token overlap, split on paragraph boundaries; `token_count` approx (chars/4).
- Admin upload ingest: same pipeline, scope from upload, NOT auto-approved.

## Frontend plan
- **Rename** PrayGyaan→Pragyaan: `PrayGyaanPage.jsx`→`PragyaanPage.jsx`, `PrayGyaanWidget.jsx`→`PragyaanWidget.jsx`, route `#/pragyaan` (keep `#/praygyaan` alias→redirect), CTA label "Ask Pragyaan AI"; update `AppShell.jsx`, `HomePage.jsx` imports/refs.
- `src/hooks/usePragyaanChat.js`: POST `/api/pragyaan/chat`, read the streamed body via `ReadableStream` reader, parse token/done frames; manage messages, streaming flag, `conversationId`, `anonId` (persist in localStorage), feedback, starters fetch. `credentials:'include'`.
- Widget + Page: streaming render, **citation chips** (deep-link to portal page/doc), **disclaimer** line, **no-answer** state (+ login prompt when gated), **starter questions**, language, **thumbs up/down** (→ /feedback).
- Admin: `src/pages/admin/PragyaanAdminPage.jsx` (+ route, nav, `RequireAdmin`): sources table (status/scope/version), upload form (reuse file upload flow), reindex/rollback/retire, **approvals queue** (chairman), **feedback review**, **analytics** cards. Use existing fetch/apiCache patterns.

## Success criteria (from ticket)
Citations ≥1 when a source exists; never fabricate (no-answer path); gated chunks never reach unauthorized roles (enforced at retrieval); EN/HI/MR; audit every source change. Zero confidential-data leakage (sev-1).
