// Wipes everything seeded by seed-mock-data.mjs.
//
// Detection is conservative — only rows tagged with the documented mock
// markers are touched. Real data is left alone.
//
// Markers (must match seed-mock-data.mjs):
//   users.email           LIKE 'mock+%@icai-nagpur.local'
//   events.slug           LIKE 'mock-%'
//   firms.registration_no LIKE 'MOCK-FRN-%'
//   employers.gstin       LIKE '07MOCK%'
//   job_postings.title    LIKE '[MOCK]%'
//   bills.vendor_name     LIKE '[MOCK]%'
//   iut_transfers.reference_number LIKE 'MOCK-IUT-%'
//   mock_tests.title      LIKE '[MOCK]%'
//   grievances.ticket_no  LIKE 'MOCK-%'
//   announcements.title   LIKE '[MOCK]%'
//   forum_threads.title   LIKE '[MOCK]%'
//   paper_presentations.slug LIKE 'mock-%'
//   ejournal_issues.slug  LIKE 'mock-%'
//   gallery_albums.title  LIKE '[MOCK]%'
//   branch_newsletters.title LIKE '[MOCK]%'
//   annual_reports.fy_label LIKE 'MOCK-FY%'
//   office_bearers.term_label LIKE 'MOCK-%'
//   rooms.name            LIKE '[MOCK]%'
//   notifications.title   LIKE '[MOCK]%'
//   payments.metadata->>'mock_seed' = 'true'
//   files.storage_path    LIKE 'mock/%'
//   icai_link_cards.title LIKE '[MOCK]%'
//   resource_comments.body LIKE '[MOCK]%'
//
// Order matters — child rows first, then parents. Most cascades work via
// users → profiles, events → registrations/cpe/channels/posts, but
// several tables (cpe_credits, room_bookings, consultations, etc.) have
// no cascade and must be deleted manually.
//
// Usage:
//   node scripts/clean-mock-data.mjs            # asks for confirmation
//   node scripts/clean-mock-data.mjs --yes      # no prompt

import "dotenv/config";
import postgres from "postgres";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const skipPrompt = process.argv.includes("--yes");
const sql = postgres(url, { max: 1, prepare: false });

// Tagging predicates (raw SQL fragments referenced by `sql.unsafe`).
const MOCK_EMAIL_LIKE  = "mock+%@icai-nagpur.local";
const MOCK_EVENT_SLUG  = "mock-%";
const MOCK_FRN_LIKE    = "MOCK-FRN-%";
const MOCK_GSTIN_LIKE  = "07MOCK%";

try {
  // ─── Counts ──────────────────────────────────────────────────────────────
  console.log("\nScanning for mock data…");

  const counts = {};
  const c = async (label, query) => {
    const [row] = await query;
    counts[label] = row.count;
  };

  await c("users (members + students)",   sql`SELECT COUNT(*)::int AS count FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE}`);
  await c("events",                       sql`SELECT COUNT(*)::int AS count FROM events WHERE slug LIKE ${MOCK_EVENT_SLUG}`);
  await c("event_registrations",          sql`SELECT COUNT(*)::int AS count FROM event_registrations WHERE event_id IN (SELECT id FROM events WHERE slug LIKE ${MOCK_EVENT_SLUG}) OR user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE})`);
  await c("cpe_credits",                  sql`SELECT COUNT(*)::int AS count FROM cpe_credits WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE}) OR event_id IN (SELECT id FROM events WHERE slug LIKE ${MOCK_EVENT_SLUG})`);
  await c("firms",                        sql`SELECT COUNT(*)::int AS count FROM firms WHERE registration_no LIKE ${MOCK_FRN_LIKE}`);
  await c("employers",                    sql`SELECT COUNT(*)::int AS count FROM employers WHERE gstin LIKE ${MOCK_GSTIN_LIKE}`);
  await c("job_postings",                 sql`SELECT COUNT(*)::int AS count FROM job_postings WHERE title LIKE '[MOCK]%'`);
  await c("bills",                        sql`SELECT COUNT(*)::int AS count FROM bills WHERE vendor_name LIKE '[MOCK]%'`);
  await c("iut_transfers",                sql`SELECT COUNT(*)::int AS count FROM iut_transfers WHERE reference_number LIKE 'MOCK-IUT-%'`);
  await c("mock_tests",                   sql`SELECT COUNT(*)::int AS count FROM mock_tests WHERE title LIKE '[MOCK]%'`);
  await c("grievances",                   sql`SELECT COUNT(*)::int AS count FROM grievances WHERE ticket_no LIKE 'MOCK-%'`);
  await c("announcements",                sql`SELECT COUNT(*)::int AS count FROM announcements WHERE title LIKE '[MOCK]%'`);
  await c("forum_threads",                sql`SELECT COUNT(*)::int AS count FROM forum_threads WHERE title LIKE '[MOCK]%'`);
  await c("paper_presentations",          sql`SELECT COUNT(*)::int AS count FROM paper_presentations WHERE slug LIKE 'mock-%'`);
  await c("ejournal_issues",              sql`SELECT COUNT(*)::int AS count FROM ejournal_issues WHERE slug LIKE 'mock-%'`);
  await c("gallery_albums",               sql`SELECT COUNT(*)::int AS count FROM gallery_albums WHERE title LIKE '[MOCK]%'`);
  await c("branch_newsletters",           sql`SELECT COUNT(*)::int AS count FROM branch_newsletters WHERE title LIKE '[MOCK]%'`);
  await c("annual_reports",               sql`SELECT COUNT(*)::int AS count FROM annual_reports WHERE fy_label LIKE 'MOCK-FY%'`);
  await c("office_bearers",               sql`SELECT COUNT(*)::int AS count FROM office_bearers WHERE term_label LIKE 'MOCK-%'`);
  await c("rooms",                        sql`SELECT COUNT(*)::int AS count FROM rooms WHERE name LIKE '[MOCK]%'`);
  await c("notifications",                sql`SELECT COUNT(*)::int AS count FROM notifications WHERE title LIKE '[MOCK]%' OR user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE})`);
  await c("payments",                     sql`SELECT COUNT(*)::int AS count FROM payments WHERE metadata->>'mock_seed' = 'true'`);
  await c("files",                        sql`SELECT COUNT(*)::int AS count FROM files WHERE storage_path LIKE 'mock/%'`);
  await c("icai_link_cards",              sql`SELECT COUNT(*)::int AS count FROM icai_link_cards WHERE title LIKE '[MOCK]%'`);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log("\nWill delete:");
  for (const [k, v] of Object.entries(counts)) console.log(`  • ${String(v).padStart(6)}  ${k}`);
  console.log(`  (plus all dependent rows that cascade — profiles, channels, posts, options, attempts, etc.)`);

  if (total === 0) {
    console.log("\nNothing to clean.\n");
    process.exit(0);
  }

  if (!skipPrompt) {
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question("\nProceed? Type 'yes' to confirm: ");
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  console.log("\nDeleting…");

  // ─── 1. Mock-test ecosystem (cascades from mock_tests cover children) ────
  await sql`DELETE FROM mock_test_answers       WHERE attempt_id     IN (SELECT id FROM mock_test_attempts     WHERE mock_test_id IN (SELECT id FROM mock_tests WHERE title LIKE '[MOCK]%'))`;
  await sql`DELETE FROM mock_test_attempts      WHERE mock_test_id   IN (SELECT id FROM mock_tests WHERE title LIKE '[MOCK]%')`;
  await sql`DELETE FROM mock_test_options       WHERE question_id    IN (SELECT id FROM mock_test_questions WHERE mock_test_id IN (SELECT id FROM mock_tests WHERE title LIKE '[MOCK]%'))`;
  await sql`DELETE FROM mock_test_questions     WHERE mock_test_id   IN (SELECT id FROM mock_tests WHERE title LIKE '[MOCK]%')`;
  await sql`DELETE FROM mock_test_registrations WHERE mock_test_id   IN (SELECT id FROM mock_tests WHERE title LIKE '[MOCK]%')`;
  await sql`DELETE FROM mock_tests              WHERE title          LIKE '[MOCK]%'`;
  console.log("  ✓ mock tests + questions + options + registrations + attempts + answers");

  // ─── 2. Resource quiz ecosystem (cascade from quizzes covers most) ──────
  await sql`DELETE FROM resource_quiz_attempts  WHERE quiz_id IN (SELECT id FROM resource_quizzes WHERE paper_id IN (SELECT id FROM paper_presentations WHERE slug LIKE 'mock-%'))`;
  await sql`DELETE FROM resource_quiz_options   WHERE question_id IN (SELECT id FROM resource_quiz_questions WHERE quiz_id IN (SELECT id FROM resource_quizzes WHERE paper_id IN (SELECT id FROM paper_presentations WHERE slug LIKE 'mock-%')))`;
  await sql`DELETE FROM resource_quiz_questions WHERE quiz_id IN (SELECT id FROM resource_quizzes WHERE paper_id IN (SELECT id FROM paper_presentations WHERE slug LIKE 'mock-%'))`;
  await sql`DELETE FROM resource_quizzes        WHERE paper_id IN (SELECT id FROM paper_presentations WHERE slug LIKE 'mock-%')`;
  console.log("  ✓ resource quizzes + questions + options + attempts");

  // ─── 3. Resource bookmarks / subscriptions / comments tied to mock users
  await sql`DELETE FROM resource_bookmarks      WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE}) OR (resource_type = 'paper' AND resource_id IN (SELECT id FROM paper_presentations WHERE slug LIKE 'mock-%')) OR (resource_type = 'ejournal' AND resource_id IN (SELECT id FROM ejournal_issues WHERE slug LIKE 'mock-%'))`;
  await sql`DELETE FROM resource_topic_subscriptions WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE})`;
  await sql`DELETE FROM resource_comments       WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE}) OR body LIKE '[MOCK]%' OR (resource_type = 'paper' AND resource_id IN (SELECT id FROM paper_presentations WHERE slug LIKE 'mock-%')) OR (resource_type = 'ejournal' AND resource_id IN (SELECT id FROM ejournal_issues WHERE slug LIKE 'mock-%'))`;
  console.log("  ✓ resource bookmarks + subscriptions + comments");

  // ─── 4. Paper presentations + e-journal issues ──────────────────────────
  await sql`DELETE FROM paper_topics    WHERE paper_id IN (SELECT id FROM paper_presentations WHERE slug LIKE 'mock-%')`;
  await sql`DELETE FROM paper_presentations WHERE slug LIKE 'mock-%'`;
  await sql`DELETE FROM ejournal_topics WHERE issue_id IN (SELECT id FROM ejournal_issues WHERE slug LIKE 'mock-%')`;
  await sql`DELETE FROM ejournal_issues WHERE slug LIKE 'mock-%'`;
  console.log("  ✓ paper presentations + e-journal issues");

  // ─── 5. Gallery (photos cascade via album) ──────────────────────────────
  await sql`DELETE FROM gallery_photos  WHERE album_id IN (SELECT id FROM gallery_albums WHERE title LIKE '[MOCK]%')`;
  await sql`DELETE FROM gallery_albums  WHERE title LIKE '[MOCK]%'`;
  console.log("  ✓ gallery albums + photos");

  // ─── 6. Newsletters + annual reports ────────────────────────────────────
  await sql`DELETE FROM branch_newsletters WHERE title LIKE '[MOCK]%'`;
  await sql`DELETE FROM annual_reports      WHERE fy_label LIKE 'MOCK-FY%'`;
  console.log("  ✓ newsletters + annual reports");

  // ─── 7. Forum (posts cascade via threads/channels; reactions via posts) ──
  await sql`DELETE FROM forum_posts   WHERE thread_id IN (SELECT id FROM forum_threads WHERE title LIKE '[MOCK]%')`;
  await sql`DELETE FROM forum_threads WHERE title LIKE '[MOCK]%'`;
  console.log("  ✓ forum threads + posts");

  // ─── 8. CPE credits + event registrations ───────────────────────────────
  await sql`DELETE FROM cpe_credits WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE}) OR event_id IN (SELECT id FROM events WHERE slug LIKE ${MOCK_EVENT_SLUG})`;
  await sql`DELETE FROM event_registrations WHERE event_id IN (SELECT id FROM events WHERE slug LIKE ${MOCK_EVENT_SLUG}) OR user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE})`;
  console.log("  ✓ event registrations + CPE credits");

  // ─── 9. Event chat ecosystem + override log (cascades from events) ──────
  // Most cascade automatically; we explicitly null out audit rows that
  // reference users to avoid orphan complaints.
  // event_chat_* tables cascade via events.id, so deleting events handles them.

  // ─── 10. Events ─────────────────────────────────────────────────────────
  await sql`DELETE FROM events WHERE slug LIKE ${MOCK_EVENT_SLUG}`;
  console.log("  ✓ events (cascades to chat channels, registrations leftovers, overrides)");

  // ─── 11. Announcements, office bearers, notifications ──────────────────
  await sql`DELETE FROM announcements   WHERE title LIKE '[MOCK]%'`;
  await sql`DELETE FROM office_bearers  WHERE term_label LIKE 'MOCK-%'`;
  await sql`DELETE FROM notifications   WHERE title LIKE '[MOCK]%' OR user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE})`;
  console.log("  ✓ announcements + office bearers + notifications");

  // ─── 12. Articleship + mentorship (cascade via student delete, but
  //          delete now to be safe and produce cleaner counts) ─────────────
  await sql`DELETE FROM articleship_matches  WHERE student_user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE})`;
  await sql`DELETE FROM mentorship_requests  WHERE student_user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE})`;
  console.log("  ✓ articleship matches + mentorship requests");

  // ─── 13. CABF, consultations (no cascade from users) ───────────────────
  await sql`DELETE FROM cabf_assistance_requests WHERE member_user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE})`;
  await sql`DELETE FROM consultations            WHERE client_user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE}) OR counselor_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE})`;
  console.log("  ✓ CABF + consultations");

  // ─── 14. Room bookings + rooms (bookings first; counselor_id is restrict) ─
  await sql`DELETE FROM room_bookings WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE}) OR room_id IN (SELECT id FROM rooms WHERE name LIKE '[MOCK]%')`;
  await sql`DELETE FROM rooms         WHERE name LIKE '[MOCK]%'`;
  console.log("  ✓ rooms + bookings");

  // ─── 15. Jobs, firms, employers ─────────────────────────────────────────
  await sql`DELETE FROM job_postings WHERE title LIKE '[MOCK]%' OR poster_user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE}) OR employer_id IN (SELECT id FROM employers WHERE gstin LIKE ${MOCK_GSTIN_LIKE}) OR firm_id IN (SELECT id FROM firms WHERE registration_no LIKE ${MOCK_FRN_LIKE})`;
  await sql`DELETE FROM employer_users WHERE employer_id IN (SELECT id FROM employers WHERE gstin LIKE ${MOCK_GSTIN_LIKE}) OR user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE})`;
  await sql`DELETE FROM employers WHERE gstin LIKE ${MOCK_GSTIN_LIKE}`;
  await sql`DELETE FROM firms     WHERE registration_no LIKE ${MOCK_FRN_LIKE}`;
  console.log("  ✓ jobs + employers + firms");

  // ─── 16. Payments + refunds (refunds first — payment FK is restrict) ────
  await sql`DELETE FROM payment_refunds WHERE notes LIKE '[MOCK]%' OR payment_id IN (SELECT id FROM payments WHERE metadata->>'mock_seed' = 'true')`;
  await sql`DELETE FROM payments        WHERE metadata->>'mock_seed' = 'true'`;
  console.log("  ✓ payments + refunds");

  // ─── 17. Bills + IUT transfers ──────────────────────────────────────────
  await sql`DELETE FROM bills          WHERE vendor_name LIKE '[MOCK]%' OR submitted_by IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE})`;
  await sql`DELETE FROM iut_transfers  WHERE reference_number LIKE 'MOCK-IUT-%' OR requested_by IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE})`;
  console.log("  ✓ bills + IUT transfers");

  // ─── 18. Grievances + icai link cards ───────────────────────────────────
  await sql`DELETE FROM grievances       WHERE ticket_no LIKE 'MOCK-%'`;
  await sql`DELETE FROM icai_link_cards  WHERE title LIKE '[MOCK]%'`;
  console.log("  ✓ grievances + icai link cards");

  // ─── 19. User role assignments (cascade via user, but be explicit) ──────
  await sql`DELETE FROM user_role_assignments WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE})`;
  console.log("  ✓ user role assignments");

  // ─── 20. Users (cascades to profiles, oauth_links, push_subs) ───────────
  await sql`DELETE FROM users WHERE email LIKE ${MOCK_EMAIL_LIKE}`;
  console.log("  ✓ users (+ profiles, oauth links, push subscriptions via cascade)");

  // ─── 21. Files (last — many FK references with SET NULL) ────────────────
  await sql`DELETE FROM files WHERE storage_path LIKE 'mock/%'`;
  console.log("  ✓ files");

  console.log("\n✓ Mock data cleaned.\n");
} catch (err) {
  console.error("\n✗ Clean failed:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  if (err.where)  console.error("  where: ", err.where);
  process.exitCode = 1;
} finally {
  await sql.end();
}
