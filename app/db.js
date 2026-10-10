require("dotenv").config();

const net = require("net");
const { Pool } = require("pg");

if (typeof net.setDefaultAutoSelectFamily === "function") {
    net.setDefaultAutoSelectFamily(false);
}

// TLS rule: any non-loopback DATABASE_URL must verify the certificate
// (Neon, RDS, …). A loopback target (the local/CI disposable PostgreSQL, or a
// developer's own postgres on this machine) is not a production connection and
// has no TLS configured, exactly like the DB_* fallback below — so it connects
// without TLS instead of failing. The rejectUnauthorized requirement for real
// deployments is never weakened.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function tlsConfigFor(connectionString) {
    try {
        const hostname = new URL(connectionString).hostname.toLowerCase();
        if (LOOPBACK_HOSTS.has(hostname)) return false;
    } catch (err) {
        // Unparseable URL: pg will produce a clear connection error on first use.
    }
    return { rejectUnauthorized: true };
}

const pool = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: tlsConfigFor(process.env.DATABASE_URL),
        autoSelectFamily: false
    })
    : new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD
    });

module.exports = pool;