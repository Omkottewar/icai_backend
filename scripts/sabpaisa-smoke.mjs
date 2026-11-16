// SabPaisa smoke test — checks config, the AES256HMACSHA384HEX round trip,
// and the Transaction Enquiry API with a made-up clientTxnId.
//
//   npx tsx scripts/sabpaisa-smoke.mjs        (from backend/, with .env loaded)
//
// A real ₹1 payment in the browser is still the only end-to-end check of
// the checkout page and the callback.

const load = (p) => import(`../server/lib/sabpaisa/${p}.ts`).catch(() => import(`../dist/server/lib/sabpaisa/${p}.js`));
const { sabpaisaEncrypt, sabpaisaDecrypt } = await load("crypto");
const { sabpaisaConfig } = await load("config");
const { enquireTransaction } = await load("client");

const pass = (m) => console.log("✓", m);
const fail = (m) => { console.log("✗", m); process.exitCode = 1; };

console.log("1. Config");
let cfg;
try {
  cfg = sabpaisaConfig();
  pass(`env=${cfg.env} clientCode=${cfg.clientCode} mcc=${cfg.mcc}`);
  pass(`initUrl=${cfg.initUrl}`);
  pass(`enquiryUrl=${cfg.enquiryUrl}`);
  pass(`callbackUrl=${cfg.callbackUrl}`);
} catch (e) {
  fail(e.message);
  process.exit();
}

console.log("\n2. Encryption round trip");
try {
  const plain = "clientCode=TEST&clientTxnId=SMOKE123&amount=1.00";
  const enc = sabpaisaEncrypt(plain, cfg.authKey, cfg.authIv);
  if (!/^[0-9A-F]+$/.test(enc)) throw new Error("output is not uppercase hex");
  if (sabpaisaDecrypt(enc, cfg.authKey, cfg.authIv) !== plain) throw new Error("round trip mismatch");
  pass(`ok (${enc.length} hex chars)`);
} catch (e) { fail(e.message); }

console.log("\n3. Transaction Enquiry (bogus id — expect not found)");
try {
  const r = await enquireTransaction(`SMOKE${Date.now()}`);
  pass(`outcome=${r.outcome} statusCode=${r.response?.statusCode ?? "-"} message=${r.response?.sabpaisaMessage ?? r.response?.status ?? "-"}`);
} catch (e) { fail(e.message); }
