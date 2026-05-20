// Reference script for the OIDC client_credentials M2M grant (D-11, AUTH-08).
// plan 17-07 (tests/e2e/m2m/) extends this into the full service-token -> createJob ->
// listJobs -> getEntities SDK chain.
//
// This script POSTs a client_credentials grant to the Dex token endpoint, decodes the
// resulting JWT, and asserts the expected claims. It does NOT require the Spatula API
// to be running — only a healthy Dex instance at http://localhost:5556/dex.
//
// Dependency-free: uses global fetch (Node 18+). No test framework.
//
// Usage:
//   npx tsx smoke/m2m-flow.ts
//   node smoke/m2m-flow.ts   # Node 18+ (fetch available by default on Node 21+)

const ISSUER = "http://localhost:5556/dex";
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const CLIENT_ID = "spatula-m2m";
// The M2M client secret is intentionally committed as a dev-only value — DO NOT use in production.
const CLIENT_SECRET = "dev-only-secret-m2m";

/** Decode a JWT payload segment (base64url → JSON). No library needed. */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const segments = jwt.split(".");
  if (segments.length !== 3) {
    throw new Error(`Invalid JWT: expected 3 segments, got ${segments.length}`);
  }
  const payload = segments[1];
  // base64url → base64 → Buffer → JSON
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "="
  );
  return JSON.parse(
    Buffer.from(padded, "base64").toString("utf8")
  ) as Record<string, unknown>;
}

async function main(): Promise<void> {
  // 1. POST client_credentials grant to the Dex token endpoint.
  let tokenResponse: Record<string, unknown>;
  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "openid",
    });

    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token endpoint HTTP ${res.status}: ${text}`);
    }

    tokenResponse = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.error(
      "m2m-flow: failed to obtain token — is Dex running at",
      ISSUER + "?"
    );
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // 2. Assert the response contains an access_token.
  const accessToken = tokenResponse["access_token"] as string | undefined;
  if (!accessToken) {
    console.error(
      "m2m-flow: token response missing access_token:",
      JSON.stringify(tokenResponse, null, 2)
    );
    process.exit(1);
  }

  // 3. Decode the JWT payload (no library — base64url the middle segment).
  let claims: Record<string, unknown>;
  try {
    claims = decodeJwtPayload(accessToken);
  } catch (err) {
    console.error("m2m-flow: failed to decode access_token JWT:");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // 4. Assert sub = spatula-m2m (Dex sets sub = client_id for client_credentials grants).
  if (claims["sub"] !== CLIENT_ID) {
    console.error(
      `m2m-flow: expected sub="${CLIENT_ID}", got sub="${String(claims["sub"])}"`
    );
    process.exit(1);
  }

  // 5. Assert aud includes spatula-m2m.
  const aud = claims["aud"];
  const audList: string[] = Array.isArray(aud)
    ? (aud as string[])
    : typeof aud === "string"
    ? [aud]
    : [];

  if (!audList.includes(CLIENT_ID)) {
    console.error(
      `m2m-flow: expected aud to include "${CLIENT_ID}", got aud=${JSON.stringify(aud)}`
    );
    process.exit(1);
  }

  // 6. Success — print result.
  console.log("m2m-flow-ok");
  console.log("\nDecoded JWT claims:");
  console.log(JSON.stringify(claims, null, 2));

  process.exit(0);
}

main().catch((err) => {
  console.error("m2m-flow: unexpected error:", err);
  process.exit(1);
});
