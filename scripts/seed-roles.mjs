import "dotenv/config";
import { db } from "../db/client.ts";
import { sql } from "drizzle-orm";

// Idempotent role seed extracted from 0003_roles_taxonomy.sql. Safe to re-run.
const result = await db.execute(sql`
  INSERT INTO "roles" ("code", "name", "scope", "singleton_per_scope", "description") VALUES
    ('branch_chairman',             'Branch Chairman',            'branch',    true,  'Elected chair of the branch managing committee'),
    ('branch_vice_chairman',        'Branch Vice Chairman',       'branch',    true,  'Vice chair of the branch managing committee'),
    ('branch_secretary',            'Branch Secretary',           'branch',    true,  'Secretary of the branch managing committee'),
    ('branch_treasurer',            'Branch Treasurer',           'branch',    true,  'Treasurer of the branch managing committee'),
    ('mcm',                         'Managing Committee Member',  'branch',    false, 'Core member of the branch MC. Office bearers also hold this role.'),
    ('committee_chairman',          'Committee Chairman',         'committee', true,  'Chair of a specific committee — must also hold mcm'),
    ('committee_convener',          'Committee Convener',         'committee', true,  'Convener of a specific committee'),
    ('committee_co_convener',       'Committee Co-Convener',      'committee', true,  'Co-convener of a specific committee'),
    ('committee_member',            'Committee Member',           'committee', false, 'Council member serving on a specific committee'),
    ('branch_manager',              'Branch Manager',             'branch',    true,  'Operational head of branch support staff'),
    ('sub_branch_manager',          'Sub-Branch Manager',         'branch',    false, 'Assistant manager for branch operations'),
    ('student_desk',                'Student Desk',               'branch',    false, 'Student services counter staff'),
    ('accountant',                  'Accountant',                 'branch',    false, 'Branch accounting / bookkeeping staff'),
    ('central_council_coordinator', 'Central Council Coordinator','branch',    true,  'Liaison with ICAI Central Council'),
    ('admin',                       'Admin',                      'global',    false, 'System administrator with full access to the admin console')
  ON CONFLICT ("code") DO UPDATE SET
    "name"                = EXCLUDED."name",
    "scope"               = EXCLUDED."scope",
    "singleton_per_scope" = EXCLUDED."singleton_per_scope",
    "description"         = EXCLUDED."description"
`);
console.log("✓ Seeded 15 canonical role codes");
process.exit(0);
