/**
 * check-dex.ts — Dex discovery-doc health probe (D-11, AUTH-04).
 *
 * Fetches the OIDC discovery doc from the local Dex instance and asserts it
 * returns a 200 with the expected issuer. Exits 0 on success, 1 on failure.
 *
 * Dependency-free: uses global fetch (Node 18+).
 *
 * Usage:
 *   npx tsx smoke/check-dex.ts
 *   node smoke/check-dex.ts   # Node 18+ with --experimental-fetch (default on 21+)
 */

export {}; // Treat as an ES module so top-level names don't collide with sibling scripts.

const ISSUER = "http://localhost:5556/dex";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;

async function main(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(DISCOVERY_URL);
  } catch (err) {
    console.error(
      `check-dex: failed to connect to ${DISCOVERY_URL} — is Dex running?`
    );
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (res.status !== 200) {
    console.error(
      `check-dex: unexpected HTTP ${res.status} from ${DISCOVERY_URL}`
    );
    process.exit(1);
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.error(
      `check-dex: discovery doc did not return valid JSON from ${DISCOVERY_URL}`
    );
    process.exit(1);
  }

  if (body.issuer !== ISSUER) {
    console.error(
      `check-dex: issuer mismatch — expected "${ISSUER}", got "${String(body.issuer)}"`
    );
    process.exit(1);
  }

  if (!body.authorization_endpoint || !body.token_endpoint) {
    console.error(
      `check-dex: discovery doc missing required fields (authorization_endpoint, token_endpoint)`
    );
    process.exit(1);
  }

  console.log("dex-ok");
  process.exit(0);
}

main().catch((err) => {
  console.error("check-dex: unexpected error:", err);
  process.exit(1);
});
