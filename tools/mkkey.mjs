// Mints an API key. Prints the token once (give it to the caller) and the
// wrangler command that stores only its SHA-256 hash in KV.
// Usage: node tools/mkkey.mjs [daily_cap_units=500] [tier=free]

import { randomBytes, createHash } from "node:crypto";

const cap = Number(process.argv[2] ?? 500);
const tier = process.argv[3] ?? "free";
const token = "jvl_" + randomBytes(24).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
const value = JSON.stringify({ tier, daily_cap: cap });

console.log(`Token (shown once, not stored anywhere):\n${token}\n`);
console.log("Store the hashed record in KV:");
console.log(`npx wrangler kv key put --binding=KV "key:${hash}" '${value}'`);
