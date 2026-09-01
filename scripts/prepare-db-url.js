// Vercel's Postgres integrations don't always expose the connection string as
// DATABASE_URL — depending on how the storage was connected, it may only set
// POSTGRES_PRISMA_URL / POSTGRES_URL / POSTGRES_URL_NON_POOLING / DATABASE_URL_UNPOOLED.
// Prisma's schema.prisma hardcodes the env var name it reads, so this script
// fills in DATABASE_URL from whichever fallback is actually present before
// `prisma generate` / `prisma migrate deploy` run.

const fs = require("fs");
const path = require("path");

if (!process.env.DATABASE_URL) {
  const fallback =
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL_UNPOOLED;

  if (fallback) {
    const envPath = path.join(__dirname, "..", ".env");
    fs.appendFileSync(envPath, `\nDATABASE_URL="${fallback}"\n`);
    console.log(
      "[prepare-db-url] DATABASE_URL was not set — filled it in from an available Postgres integration variable."
    );
  } else {
    console.warn(
      "[prepare-db-url] No DATABASE_URL (or known Postgres integration variable) found.\n" +
        "  -> In Vercel: Storage tab, connect a Postgres database to this project,\n" +
        "     making sure Preview/Development environments are included, not just Production.\n" +
        "  -> Or add DATABASE_URL manually under Settings -> Environment Variables."
    );
  }
}
