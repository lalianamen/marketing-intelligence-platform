// Secret scan for a PUBLIC repository.
//   node scripts/check-secrets.mjs           → scans files git would commit
//   node scripts/check-secrets.mjs --bundle  → scans the built client bundle (.next/static)
// Exits non-zero on any finding. CI additionally runs gitleaks.
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PATTERNS = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GCP service account JSON", /"type"\s*:\s*"service_account"/],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["Google OAuth client secret", /GOCSPX-[0-9A-Za-z_-]{20,}/],
  ["Google OAuth refresh token", /\b1\/\/0[0-9A-Za-z_-]{30,}/],
  ["Google access token", /\bya29\.[0-9A-Za-z_-]{30,}/],
  ["Supabase secret key", /\bsb_secret_[0-9A-Za-z_-]{20,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}/],
  ["Stripe live key", /\b(sk|rk)_live_[0-9A-Za-z]{20,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["assigned secret", /^(?:SUPABASE_SERVICE_ROLE_KEY|TOKEN_ENCRYPTION_KEY|GOOGLE_OAUTH_CLIENT_SECRET|GOOGLE_ADS_DEVELOPER_TOKEN|BING_OAUTH_CLIENT_SECRET)=\S+/m],
];
// Lines may opt out only with an explicit marker (used for synthetic test fixtures).
const ALLOW_MARKER = "secret-scan:allow-fixture";
const FORBIDDEN_FILES = [/(^|\/)\.env(\.|$)(?!example$)/, /service-account.*\.json$/i, /credentials.*\.json$/i, /\.pem$/, /\.key$/];

let findings = [];

function scanText(file, text, patterns = PATTERNS) {
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.includes(ALLOW_MARKER) || (lines[i - 1] ?? "").includes(ALLOW_MARKER)) return;
    for (const [name, re] of patterns) if (re.test(line)) findings.push(`${file}:${i + 1}: ${name}`);
  });
}

if (process.argv.includes("--bundle")) {
  const root = ".next/static";
  if (!existsSync(root)) {
    console.error("No .next/static — run `npm run build` first.");
    process.exit(2);
  }
  // Values that must never reach the browser (read from the local env, if present).
  const env = existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "";
  const serverValues = ["SUPABASE_SERVICE_ROLE_KEY", "TOKEN_ENCRYPTION_KEY", "DATABASE_URL", "WAREHOUSE_LOCAL_URL", "GOOGLE_OAUTH_CLIENT_SECRET", "BING_OAUTH_CLIENT_SECRET"]
    .map((k) => [k, new RegExp(`^${k}=(.+)$`, "m").exec(env)?.[1]])
    .filter(([, v]) => v && v.length > 8);
  const extra = [
    ["service role marker", /service_role/],
    ["postgres connection string", /postgres(?:ql)?:\/\/[^"'\s]+:[^"'\s]+@/],
    ["server env name", /SUPABASE_SERVICE_ROLE_KEY|TOKEN_ENCRYPTION_KEY|GOOGLE_OAUTH_CLIENT_SECRET|BING_OAUTH_CLIENT_SECRET/],
  ];
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const f of walk(root)) {
    const text = readFileSync(f, "utf8");
    for (const [k, v] of serverValues) if (text.includes(v)) findings.push(`${f}: contains value of ${k}`);
    scanText(f, text, [...PATTERNS.filter(([n]) => n !== "JWT"), ...extra]);
  }
} else {
  const files = execSync("git ls-files --cached --others --exclude-standard", { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const f of files) {
    if (FORBIDDEN_FILES.some((re) => re.test(f))) findings.push(`${f}: file type must never be committed`);
    if (!existsSync(f) || statSync(f).size > 2_000_000 || /\.(png|jpg|ico|woff2?)$/.test(f)) continue;
    scanText(f, readFileSync(f, "utf8"));
  }
}

if (findings.length) {
  console.error(`Secret scan FAILED (${findings.length}):\n` + findings.join("\n"));
  process.exit(1);
}
console.log(`Secret scan passed (${process.argv.includes("--bundle") ? "client bundle" : "repository files"}).`);
