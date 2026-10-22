require("dotenv").config();

const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { Pool } = require("pg");

function localDatabaseHost(connectionString) {
  const hostname = new URL(connectionString).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return ["localhost", "127.0.0.1", "::1"].includes(hostname);
}

function maskEmail(email) {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
  if (!localDatabaseHost(process.env.DATABASE_URL)) {
    throw new Error("Admin bootstrap is local-only and refuses non-local PostgreSQL hosts.");
  }

  const email = (process.argv[2] || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Pass the exact existing account email as the only argument.");
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const matches = await client.query(
      `SELECT id::text AS id,email,role,is_active FROM public.users WHERE lower(email)=lower($1) FOR UPDATE`,
      [email]
    );
    if (matches.rowCount !== 1) throw new Error(`Expected exactly one account match; found ${matches.rowCount}. No change made.`);
    const account = matches.rows[0];
    if (!account.is_active) throw new Error("The account is inactive. No change made.");
    if (account.role !== "customer") throw new Error(`The account role is ${account.role}; only an active customer can be promoted. No change made.`);

    console.log(`Matched account ID ${account.id} (${maskEmail(account.email)}), role customer, active.`);
    const confirmation = await prompt.question(`To grant this account admin access, type exactly PROMOTE ${email}: `);
    if (confirmation.trim() !== `PROMOTE ${email}`) throw new Error("Confirmation did not match. No change made.");

    const updated = await client.query(
      `UPDATE public.users SET role='admin',updated_at=NOW() WHERE id=$1 AND lower(email)=lower($2) AND role='customer' AND is_active=TRUE RETURNING id::text AS id,role,is_active`,
      [account.id, email]
    );
    if (updated.rowCount !== 1 || updated.rows[0].role !== "admin" || updated.rows[0].is_active !== true) {
      throw new Error(`Promotion verification failed (affected ${updated.rowCount} rows). Transaction will be rolled back.`);
    }
    await client.query("COMMIT");
    inTransaction = false;
    console.log(`Verified admin role for account ID ${updated.rows[0].id}. Sign in again to obtain an admin token.`);
  } finally {
    prompt.close();
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Admin bootstrap stopped: ${error.message}`);
  process.exitCode = 1;
});
