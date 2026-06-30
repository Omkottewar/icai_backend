// One-off diagnostic: count rows in resource_topics and icai_link_cards.
// Used to determine why the admin Topics / ICAI link cards tabs render empty.
import 'dotenv/config';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

const sql = postgres(url, { ssl: 'prefer' });

const topics = await sql`SELECT code, name, active FROM resource_topics ORDER BY sort_order`;
const cards  = await sql`SELECT category, title, active FROM icai_link_cards ORDER BY category, sort_order`;

console.log('─── resource_topics ───');
console.log(`count: ${topics.length}`);
topics.forEach((t) => console.log(`  ${t.active ? '●' : '○'} ${t.code.padEnd(16)} ${t.name}`));

console.log('\n─── icai_link_cards ───');
console.log(`count: ${cards.length}`);
cards.forEach((c) => console.log(`  ${c.active ? '●' : '○'} [${c.category.padEnd(14)}] ${c.title}`));

await sql.end();
