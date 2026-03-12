#!/usr/bin/env node
/**
 * Generates OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, and JWT_SECRET
 * and writes them into .env (creates it if missing, updates if it exists).
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env");

const generated = {
  OAUTH_CLIENT_ID:     `mcp_${crypto.randomBytes(12).toString("hex")}`,
  OAUTH_CLIENT_SECRET: crypto.randomBytes(32).toString("hex"),
  JWT_SECRET:          crypto.randomBytes(48).toString("base64url"),
};

// Read existing .env (if any) and parse it into key→value pairs
let existing = {};
if (fs.existsSync(ENV_FILE)) {
  const lines = fs.readFileSync(ENV_FILE, "utf8").split("\n");
  for (const line of lines) {
    const match = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (match) existing[match[1].trim()] = match[2].trim();
  }
}

// Merge: generated values overwrite only the three target keys
const merged = { ...existing, ...generated };

// Serialize back preserving comment lines from the original file
const originalLines = fs.existsSync(ENV_FILE)
  ? fs.readFileSync(ENV_FILE, "utf8").split("\n")
  : [];

const seen = new Set();
const outputLines = [];

for (const line of originalLines) {
  const match = line.match(/^([^#=\s][^=]*)=/);
  if (match) {
    const key = match[1].trim();
    seen.add(key);
    outputLines.push(`${key}=${merged[key] ?? ""}`);
  } else {
    outputLines.push(line);
  }
}

// Append any new keys that weren't in the original file
for (const [key, val] of Object.entries(merged)) {
  if (!seen.has(key)) {
    outputLines.push(`${key}=${val}`);
  }
}

fs.writeFileSync(ENV_FILE, outputLines.join("\n"), "utf8");

console.log("✔ Secrets written to .env");
console.log(`  OAUTH_CLIENT_ID     = ${generated.OAUTH_CLIENT_ID}`);
console.log(`  OAUTH_CLIENT_SECRET = ${generated.OAUTH_CLIENT_SECRET}`);
console.log(`  JWT_SECRET          = ${generated.JWT_SECRET}`);
console.log("\nAdd MASSIVE_API_KEY to .env if you haven't already.");
