"use strict";

/**
 * KaliNova — config-guard-test
 *
 * Offline checks for the production/development gates in app/config.js. No
 * database is ever touched (config.js makes no connection), and every case runs
 * in a clean child process whose environment is fully controlled, so a stray
 * DATABASE_URL or secret on the host cannot skew a result. Nothing secret is
 * ever printed.
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

function loadConfig(env) {
  return spawnSync(process.execPath, ["-e", "require('./config')"], {
    cwd: APP_DIR,
    encoding: "utf8",
    env: Object.assign(
      {
        PATH: process.env.PATH,
        NODE_ENV: "",
        DATABASE_URL: "",
        ADMIN_SESSION_SECRET: "",
        JWT_SECRET: ""
      },
      env
    )
  });
}

const strongSecret = "b".repeat(48) + "9f3c1a";
const prodUrl = "postgresql://u:p@host.example.com:5432/db?sslmode=require";

function boot(label, env) {
  const r = loadConfig(env);
  check(label, r.status === 0, `status ${r.status}: ${String((r.stderr || "").split("\n")[0])}`);
}

function refuse(label, env, pattern) {
  const r = loadConfig(env);
  check(
    label,
    r.status !== 0 && new RegExp(pattern).test(String(r.stderr || "")),
    `status ${r.status}: ${String((r.stderr || "").split("\n")[0])}`
  );
}

console.log("\n[1] NODE_ENV validation");
refuse("NODE_ENV='Production' is refused", { NODE_ENV: "Production" }, "NODE_ENV must be exactly");
refuse("NODE_ENV='PRODUCTION' is refused", { NODE_ENV: "PRODUCTION" }, "NODE_ENV must be exactly");
refuse("NODE_ENV='test' is refused", { NODE_ENV: "test" }, "NODE_ENV must be exactly");
boot("NODE_ENV unset keeps development", {});
boot("NODE_ENV='development' boots", { NODE_ENV: "development", ADMIN_SESSION_SECRET: strongSecret });
boot("NODE_ENV=' production ' is normalised to production and boots with a URL",
  { NODE_ENV: " production ", DATABASE_URL: prodUrl, ADMIN_SESSION_SECRET: strongSecret });

console.log("\n[2] Production DATABASE_URL requirement");
refuse("production refuses to start without DATABASE_URL",
  { NODE_ENV: "production", ADMIN_SESSION_SECRET: strongSecret },
  "DATABASE_URL must be set");
boot("production starts with DATABASE_URL and a strong secret",
  { NODE_ENV: "production", DATABASE_URL: prodUrl, ADMIN_SESSION_SECRET: strongSecret });

console.log("\n[3] Production session-secret requirements (still enforced)");
refuse("production refuses a placeholder secret",
  { NODE_ENV: "production", DATABASE_URL: prodUrl, ADMIN_SESSION_SECRET: "change-this-in-production" },
  "placeholder|ADMIN_SESSION_SECRET");
refuse("production refuses a short secret",
  { NODE_ENV: "production", DATABASE_URL: prodUrl, ADMIN_SESSION_SECRET: "too-short" },
  "32 characters");
refuse("production refuses dev-only placeholder",
  { NODE_ENV: "production", DATABASE_URL: prodUrl, ADMIN_SESSION_SECRET: "dev-only-secret-replace-me-with-48-random-hex-chars" },
  "placeholder");

console.log(`\n${failures === 0 ? `ALL ${checks} CHECKS PASSED` : `${failures} of ${checks} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);