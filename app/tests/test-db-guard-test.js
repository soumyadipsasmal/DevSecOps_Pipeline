"use strict";

/**
 * KaliNova — test-db-guard-test
 *
 * Offline checks for app/tests/test-db-guard.js. Every case runs in a clean
 * child process whose environment fully controls DATABASE_URL and
 * TEST_DATABASE_URL (empty strings mean "unset", and dotenv never overrides an
 * already-set variable, so app/.env cannot leak into a case). Fake URL strings
 * only — nothing is connected, nothing is printed.
 */

const { spawnSync } = require("child_process");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");

let checks = 0;
let failures = 0;

function check(label, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : " -> " + detail}`);
}

function runGuard({ databaseUrl = "", testUrl = "", ci = "", githubActions = "" }) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      "require('./tests/test-db-guard'); console.log(process.env.DATABASE_URL === require('process').env.TEST_DATABASE_URL ? 'REBOUND' : 'NOT-REBOUND');"
    ],
    {
      cwd: APP_DIR,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: databaseUrl,
        TEST_DATABASE_URL: testUrl,
        CI: ci,
        GITHUB_ACTIONS: githubActions
      }
    }
  );
}

const PROD = "postgresql://prod:pass@ep-abc.us-east-1.aws.neon.tech/neondb?sslmode=verify-full";

console.log("\n[1] TEST_DATABASE_URL is required and no env bypass exists");
for (const env of [
  { ci: "", githubActions: "" },
  { ci: "true", githubActions: "" },
  { ci: "true", githubActions: "true" },
  { ci: "true", githubActions: "true", databaseUrl: PROD }
]) {
  const r = runGuard(env);
  check(
    `runs with TEST_DATABASE_URL empty (CI=${env.ci || "unset"} GITHUB_ACTIONS=${env.githubActions || "unset"}) are refused`,
    r.status !== 0 && /Set TEST_DATABASE_URL|TEST_DATABASE_URL is not a valid/.test(String(r.stderr || "")),
    `status ${r.status}`
  );
}

console.log("\n[2] URL structure validation (fail-closed)");
for (const [label, url] of [
  ["not a URL", "not-a-url"],
  ["http scheme", "http://u:p@host.example.com:5432/db"],
  ["missing username", "postgresql://host.example.com:5432/db"],
  ["missing database in path", "postgresql://u:p@host.example.com:5432"],
  ["non-numeric port", "postgresql://u:p@host.example.com:abc/db"]
]) {
  const r = runGuard({ databaseUrl: PROD, testUrl: url });
  check(`refuses ${label}`, r.status !== 0 && /not a valid PostgreSQL URL/.test(String(r.stderr || "")), `status ${r.status}`);
}

console.log("\n[3] Same endpoint as production is refused (conservative)");
const POOLER = "postgresql://prod:pass@ep-abc-pooler.us-east-1.aws.neon.tech/neondb";
const SAME_ENDPOINT_CASES = [
  ["bit-identical endpoint", PROD, PROD],
  ["default port vs explicit 5432", PROD, "postgresql://prod:pass@ep-abc.us-east-1.aws.neon.tech:5432/neondb"],
  ["same host, different database name", PROD, "postgresql://prod:pass@ep-abc.us-east-1.aws.neon.tech/testdb"],
  ["same host, different username", PROD, "postgresql://other:pass@ep-abc.us-east-1.aws.neon.tech/neondb"],
  ["Neon direct vs pooler alias", PROD, "postgresql://prod:pass@ep-abc-pooler.us-east-1.aws.neon.tech/neondb"],
  ["Neon pooler vs direct alias", POOLER, PROD]
];
for (const [label, databaseUrl, testUrl] of SAME_ENDPOINT_CASES) {
  const r = runGuard({ databaseUrl, testUrl });
  check(`refuses ${label}`, r.status !== 0 && /same database endpoint/.test(String(r.stderr || "")), `status ${r.status}`);
}

console.log("\n[4] A genuinely separate endpoint is allowed and binds the pool");
for (const [label, testUrl] of [
  ["different host, db, user and port", "postgresql://tester:pass@ep-test99.eu-west-1.aws.neon.tech:5433/lab?sslmode=verify-full"],
  ["loopback disposable target with production configured", "postgresql://medium_user:medium_pass@localhost:5434/medium_clone"]
]) {
  const r = runGuard({ databaseUrl: PROD, testUrl });
  const rebound = r.status === 0 && r.stdout.includes("REBOUND");
  check(`allows ${label} and rebinds DATABASE_URL`, rebound, `status ${r.status} stdout ${String(r.stdout).trim()}`);
}

console.log("[5] Malformed production DATABASE_URL is itself a refusal");
{
  const r = runGuard({ databaseUrl: "not-a-url", testUrl: "postgresql://u:p@other.example.com:5432/db" });
  check("refuses when app/.env DATABASE_URL is unparseable",
    r.status !== 0 && /DATABASE_URL read from app\/\.env is not a valid/.test(String(r.stderr || "")), `status ${r.status}`);
}

console.log(`\n${failures === 0 ? `ALL ${checks} CHECKS PASSED` : `${failures} of ${checks} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);