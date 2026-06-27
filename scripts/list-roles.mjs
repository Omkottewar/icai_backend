import "dotenv/config";
import { db } from "../db/client.ts";
import { roles } from "../schema/index.ts";
const r = await db.select().from(roles);
console.log(`${r.length} roles found:`);
for (const row of r) console.log(`  - ${row.code}  (scope=${row.scope})  name="${row.name}"  id=${row.id}`);
process.exit(0);
