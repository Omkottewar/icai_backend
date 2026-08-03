// Seeds long-form "About the committee" copy + Chairman/Convenor/Dy-Convenor
// names for the standing committees whose descriptions were shared by the
// client. Populates one site_content row per committee at slug
// `event_committee_<lowercase_code>` so the values render on the public
// committee detail page (EventsPage.jsx → CommitteeAboutSection +
// CommitteeLeadershipSection).
//
// Photos are NOT included here — admins upload them via
// /admin/site-content → Events → <committee>.
//
// Idempotent — merges into the existing JSONB row so any admin edits to
// other fields (chairman_message, chairman_photo, etc.) are preserved.
//
// Usage: node scripts/seed-committee-content.mjs

import "dotenv/config";
import postgres from "postgres";

// Long-form paragraphs are stored as markdown. Blank line = new paragraph.
const CONTENT = {
  DT_SG: {
    about_md:
`The Direct Tax Committee of the Nagpur Branch of ICAI (WIRC), under the Chairmanship of CA Ankush Kesharwani, with CA Kailash Jogani as Convener and CA Pranav Ashtikar as Deputy Convener, is committed to enhancing the professional knowledge and practical skills of Chartered Accountants in the field of direct taxation.

The Committee regularly organizes seminars, workshops, panel discussions, and interactive sessions on contemporary and practice-oriented direct tax topics. Its focus is to keep members updated with the latest legislative amendments, judicial pronouncements, and practical issues, thereby contributing to continuous professional development and excellence in tax practice.`,
    chairman_name:    "CA Ankush Kesharwani",
    convenor_name:    "CA Kailash Jogani",
    dy_convenor_name: "CA Pranav Ashtikar",
  },

  FELLOWSHIP: {
    about_md:
`The Fellowship Committee is one of the most vibrant and engaging committees of the Nagpur Branch of ICAI (WIRC). Under the Chairmanship of CA Ankush Kesharwani, with CA Saket Bagadiya as Convener and CA Pawan Khabiya as Deputy Convener, the Committee is dedicated to fostering friendship, unity, and a strong sense of belonging among the members of the profession.

The Committee organizes a variety of fellowship and recreational events throughout the year, including Holi Milan, Deepawali Milan, family get-togethers, sports tournaments such as cricket, volleyball, and swimming, as well as other interactive activities. These initiatives provide members with opportunities to unwind, interact beyond the professional environment, and strengthen personal bonds.

The Committee's primary objective is to maximize member participation, encourage active involvement of members and their families, enhance networking opportunities, and create a culture of togetherness. Through its vibrant initiatives, the Fellowship Committee plays a significant role in strengthening the spirit of fraternity and enriching the overall member experience at the Nagpur Branch.`,
    chairman_name:    "CA Ankush Kesharwani",
    convenor_name:    "CA Saket Bagadiya",
    dy_convenor_name: "CA Pawan Khabiya",
  },

  BFSI_SG: {
    about_md:
`The BFSI Committee (Banking, Financial Services & Insurance) is a dedicated Study Group constituted by the ICAI Nagpur Branch (WIRC) with the objective of enhancing the professional knowledge and capabilities of Chartered Accountants in the Banking, Financial Services, and Insurance (BFSI) sector.

The Committee serves as a platform for continuous learning by organising seminars, workshops, panel discussions, certification programmes, and technical sessions on a broad spectrum of subjects relating to the BFSI industry. Key focus areas include Bank Audit regulations, RBI guidelines, credit and risk management, project and infrastructure finance, financial markets, NBFCs, insurance, fintech, digital banking, financial reporting, regulatory compliance, forensic and concurrent audits, internal audits, and emerging developments in the financial sector.

The Committee aims to equip members with practical insights, technical expertise, and industry-oriented knowledge, enabling them to confidently undertake professional assignments across the BFSI domain and explore emerging opportunities in this specialised area of practice.

To deliver meaningful and high-quality learning initiatives, the Committee actively collaborates with various Committees of the Institute of Chartered Accountants of India (ICAI), regulatory authorities, banks, financial institutions, insurance companies, industry experts, and other professional bodies. Such collaborations ensure that members remain abreast of the latest regulatory developments, technological advancements, and best practices shaping the BFSI ecosystem.

Through its focused initiatives, the Committee strives to promote professional excellence, encourage specialization, and empower Chartered Accountants to play a significant role in strengthening India's Banking, Financial Services, and Insurance sector.`,
    chairman_name:    "CA Vinod Vijay Agrawal",
    convenor_name:    "CA Mahesh Rathi",
    dy_convenor_name: "CA Vishal Nabira",
  },

  SUBSIDIES_SG: {
    about_md:
`The Subsidies and Incentives Committee is a dedicated Study Group constituted by the ICAI Nagpur Branch (WIRC) with the objective of enhancing the professional competence of Chartered Accountants in the area of Government Subsidies, Incentives, and MSME support schemes.

The Committee regularly organises seminars, workshops, knowledge sessions, and awareness programmes covering various Central and State Government Subsidies, Incentive Schemes, and other policy initiatives applicable to industrial undertakings, MSMEs, startups, and other eligible entities. These initiatives are designed to equip members with practical knowledge and implementation skills, enabling them to effectively undertake professional assignments relating to subsidies and incentives.

The Committee also collaborates with various Committees of the Institute of Chartered Accountants of India (ICAI), Government Departments, Financial Institutions, and Industry Bodies to conduct meaningful and value-driven programmes that keep members abreast of the latest developments, policy changes, and emerging opportunities in this specialized area of practice.

Through its continuous learning initiatives, the Committee aims to create a strong knowledge ecosystem, empowering members to deliver high-quality advisory and consultancy services while contributing to the growth of industry and the MSME sector.`,
    chairman_name:    "CA Vinod Vijay Agrawal",
    convenor_name:    "CA Julfesh Shah",
    dy_convenor_name: "CA Nitin Agrawal",
  },

  COOP_SG: {
    about_md:
`The Cooperative Committee is a dedicated Study Group constituted by the ICAI Nagpur Branch (WIRC) with the objective of enhancing the professional knowledge and expertise of Chartered Accountants in the Cooperative sector. The Committee is committed to promoting awareness, strengthening technical competence, and creating opportunities for members to develop specialized practice in this important sector of the economy.

The Committee regularly organises seminars, workshops, technical sessions, panel discussions, and interactive programmes covering various aspects of Cooperative Laws, Accounting Standards, Audit and Assurance, Governance, Financial Reporting, Taxation, Regulatory Compliance, and sector-specific issues relating to Credit Cooperative Societies, Cooperative Banks, Housing Societies, Dairy Cooperatives, Agricultural Cooperatives, Marketing Cooperatives, and other Cooperative Institutions.

The Committee aims to equip members with practical insights, regulatory updates, and implementation-oriented knowledge, enabling them to effectively undertake statutory audits, internal audits, advisory, compliance, governance, and consultancy assignments in the Cooperative sector.

To provide high-quality and relevant learning opportunities, the Committee actively collaborates with various Committees of the Institute of Chartered Accountants of India (ICAI), Cooperative Departments of the Central and State Governments, regulatory authorities, Cooperative Federations, academic institutions, and subject matter experts. These collaborations ensure that members remain updated on legislative changes, emerging challenges, and evolving best practices in the Cooperative ecosystem.

Through its continuous professional development initiatives, the Committee strives to foster specialization, promote excellence in professional services, and empower Chartered Accountants to contribute effectively towards the growth, transparency, and sustainability of the Cooperative movement in India.`,
    chairman_name:    "CA Vinod Vijay Agrawal",
    convenor_name:    "CA Tusharkanti Dable",
    dy_convenor_name: "CA Rajesh Gatagat",
  },

  GST_SG: {
    about_md:
`The GST Committee, chaired by CA Deepak Jethwani, is committed to enhancing members' knowledge and professional competence in Goods & Services Tax. With CA Satish Sarda as Convenor and CA Jai Poptani as Deputy Convenor, the Committee organizes seminars, study circles, workshops, and interactive sessions on recent amendments, practical issues, and emerging developments in GST, enabling members to stay updated and deliver quality professional services.`,
    chairman_name:    "CA Deepak Jethwani",
    convenor_name:    "CA Satish Sarda",
    dy_convenor_name: "CA Jai Poptani",
  },

  CORP_LAW: {
    about_md:
`The Corporate Laws Committee, chaired by CA Deepak Jethwani, focuses on strengthening members' expertise in corporate and allied laws. With CA O. S. Bagdia as Convenor, the Committee conducts seminars, study circles, workshops, and knowledge-sharing sessions on the Companies Act, LLP laws, corporate governance, and other regulatory developments, helping members stay abreast of the evolving legal and compliance landscape.`,
    chairman_name:    "CA Deepak Jethwani",
    convenor_name:    "CA O. S. Bagdia",
  },
};

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

try {
  // Confirm the committees exist first — the seed is a no-op if a code
  // is missing so we don't create orphan site_content rows that reference
  // a committee code the DB doesn't know about.
  const codes = Object.keys(CONTENT);
  const existing = await sql`SELECT code FROM committees WHERE code IN ${sql(codes)}`;
  const existingCodes = new Set(existing.map((r) => r.code));

  let seeded = 0;
  let skipped = 0;
  for (const [code, payload] of Object.entries(CONTENT)) {
    if (!existingCodes.has(code)) {
      console.log(`⚠ Skipped ${code} — committee not found in DB (run seed-committees-nagpur.mjs first)`);
      skipped++;
      continue;
    }
    const slug = `event_committee_${code.toLowerCase()}`;

    // Merge into any pre-existing site_content row so a manual admin
    // edit (e.g. an uploaded chairman photo) doesn't get wiped. The
    // JSONB `||` operator right-biases, so the seed values win over
    // any stale content for the fields the seed sets.
    await sql`
      INSERT INTO site_content (slug, data, updated_at)
      VALUES (${slug}, ${sql.json(payload)}, NOW())
      ON CONFLICT (slug) DO UPDATE
        SET data = site_content.data || EXCLUDED.data,
            updated_at = NOW()
    `;
    console.log(`✓ Seeded ${slug} — ${payload.chairman_name}`);
    seeded++;
  }
  console.log(`\nDone. ${seeded} seeded, ${skipped} skipped.`);
} catch (err) {
  console.error("✗ Failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
