require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });

const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

class SetupError extends Error {}

function maskEmail(email) {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

function validateEmail(email) {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new SetupError("Enter a valid email address of at most 255 characters.");
  }
  return normalized;
}

function validateName(name) {
  const normalized = name.trim();
  if (!normalized || normalized.length > 150) {
    throw new SetupError("Enter a name between 1 and 150 characters.");
  }
  return normalized;
}

function validatePassword(password) {
  const categories = [/[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)];
  if (password.length < 12 || categories.filter(Boolean).length < 3) {
    throw new SetupError("Use at least 12 characters and include characters from at least 3 of these groups: lowercase, uppercase, numbers, symbols.");
  }
  if (Buffer.byteLength(password, "utf8") > 72) {
    throw new SetupError("The password must be no more than 72 UTF-8 bytes for bcrypt compatibility.");
  }
}

function promptHidden(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new SetupError("Hidden password input requires an interactive terminal. Run this command directly in PowerShell or Command Prompt.");
  }

  stdout.write(label);
  stdin.setEncoding("utf8");
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003" || character === "\u0004") return finish(new SetupError("Input cancelled."));
        if (character === "\u007f" || character === "\b") {
          value = [...value].slice(0, -1).join("");
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function validateUsersSchema(client) {
  const result = await client.query(
    `SELECT column_name, data_type, is_nullable, column_default, is_identity, character_maximum_length
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users'
     ORDER BY ordinal_position`
  );
  if (result.rowCount === 0) {
    throw new SetupError("Prerequisite missing: public.users does not exist. Apply the project's schema before creating an administrator.");
  }

  const columns = new Map(result.rows.map((column) => [column.column_name, column]));
  const expected = {
    id: ["bigint", "NO"],
    name: ["character varying", "NO"],
    email: ["character varying", "NO"],
    password_hash: ["text", "NO"],
    role: ["character varying", "NO"],
    is_active: ["boolean", "NO"],
    created_at: ["timestamp with time zone", "NO"],
    updated_at: ["timestamp with time zone", "NO"],
  };
  for (const [columnName, [dataType, nullable]] of Object.entries(expected)) {
    const column = columns.get(columnName);
    if (!column || column.data_type !== dataType || column.is_nullable !== nullable) {
      throw new SetupError(`Prerequisite missing: public.users.${columnName} does not match the schema required by this application.`);
    }
  }

  if (columns.get("name").character_maximum_length < 150 || columns.get("email").character_maximum_length < 255) {
    throw new SetupError("Prerequisite missing: public.users name/email columns are too short for the application schema.");
  }
  if (columns.get("id").is_identity !== "YES" && !columns.get("id").column_default) {
    throw new SetupError("Prerequisite missing: public.users.id must generate IDs automatically.");
  }
  for (const name of ["created_at", "updated_at"]) {
    if (!columns.get(name).column_default) {
      throw new SetupError(`Prerequisite missing: public.users.${name} must have a database default.`);
    }
  }

  const unfilledRequired = result.rows.find((column) =>
    column.is_nullable === "NO" &&
    !["id", "name", "email", "password_hash", "role", "is_active"].includes(column.column_name) &&
    !column.column_default &&
    column.is_identity !== "YES"
  );
  if (unfilledRequired) {
    throw new SetupError(`Prerequisite missing: public.users.${unfilledRequired.column_name} is required and has no default.`);
  }

  const constraints = await client.query(
    `SELECT pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conrelid = 'public.users'::regclass AND contype = 'c'`
  );
  const roleCheck = constraints.rows.some(({ definition }) =>
    /\brole\b/i.test(definition) && /'admin'/i.test(definition) && /'customer'/i.test(definition)
  );
  if (!roleCheck) {
    throw new SetupError("Prerequisite missing: public.users must have a role constraint that allows both admin and customer.");
  }

  const uniqueEmail = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
       WHERE n.nspname = 'public' AND t.relname = 'users'
         AND i.indisunique AND i.indpred IS NULL AND i.indnkeyatts = 1 AND a.attname = 'email'
     ) AS has_unique_email`
  );
  if (!uniqueEmail.rows[0].has_unique_email) {
    throw new SetupError("Prerequisite missing: public.users.email must have a unique constraint.");
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new SetupError("DATABASE_URL is not configured in the project .env file.");
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let client;
  let inTransaction = false;
  let prompt;
  try {
    client = await pool.connect();
    await validateUsersSchema(client);

    prompt = readline.createInterface({ input: stdin, output: stdout });
    const email = validateEmail(await prompt.question("Administrator email: "));
    prompt.close();
    prompt = null;

    await client.query("BEGIN");
    inTransaction = true;
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [1935764580, 1]);

    const admins = await client.query(
      "SELECT email FROM public.users WHERE role = 'admin' ORDER BY id LIMIT 1"
    );
    if (admins.rowCount > 0) {
      throw new SetupError(`An administrator account already exists (${maskEmail(admins.rows[0].email)}). Do not create another; use the existing account or have an authorized database administrator review recovery options.`);
    }

    const existing = await client.query(
      "SELECT email FROM public.users WHERE lower(email) = $1 LIMIT 1",
      [email]
    );
    if (existing.rowCount > 0) {
      throw new SetupError(`An account already exists for ${maskEmail(existing.rows[0].email)}. No role or password was changed. If it is your active customer account, use the existing controlled promotion command only after confirming the account: npm run admin:promote -- ${email}.`);
    }

    const namePrompt = readline.createInterface({ input: stdin, output: stdout });
    let name;
    try {
      name = validateName(await namePrompt.question("Administrator name: "));
    } finally {
      namePrompt.close();
    }

    const password = await promptHidden("Administrator password (input hidden): ");
    validatePassword(password);
    const confirmation = await promptHidden("Confirm password: ");
    if (password !== confirmation) throw new SetupError("Passwords do not match. No account was created.");

    const passwordHash = await bcrypt.hash(password, 12);
    const created = await client.query(
      `INSERT INTO public.users (name, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'admin', TRUE)
       RETURNING role, is_active`,
      [name, email, passwordHash]
    );
    if (created.rowCount !== 1 || created.rows[0].role !== "admin" || created.rows[0].is_active !== true) {
      throw new SetupError("Account verification failed; the transaction will be rolled back.");
    }

    await client.query("COMMIT");
    inTransaction = false;
    console.log(`Created active administrator account for ${maskEmail(email)}. Sign in at http://localhost:3000/admin.`);
  } finally {
    if (prompt) prompt.close();
    if (inTransaction && client) await client.query("ROLLBACK").catch(() => {});
    if (client) client.release();
    await pool.end();
  }
}

main().catch((error) => {
  if (error instanceof SetupError) {
    console.error(`Admin setup stopped: ${error.message}`);
  } else {
    const code = typeof error.code === "string" && /^[A-Z0-9]+$/.test(error.code) ? ` (database error ${error.code})` : "";
    console.error(`Admin setup failed${code}. Check database connectivity and the project schema; no credentials or database details were printed.`);
  }
  process.exitCode = 1;
});
