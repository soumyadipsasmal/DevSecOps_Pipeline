require("dotenv").config();

const express = require("express");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { body, validationResult } = require("express-validator");
const pool = require("./db");

// Fail fast if required secrets are missing
if (!process.env.JWT_SECRET) {
    console.error("FATAL: JWT_SECRET environment variable is not set.");
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3007;

// Trust the first proxy hop (needed for correct req.ip behind a load balancer / reverse proxy)
app.set("trust proxy", 1);

// ===============================
// SECURITY MIDDLEWARE
// ===============================

app.use(helmet());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(
    cors({
        origin: allowedOrigins.length > 0 ? allowedOrigins : false,
        methods: ["GET", "POST", "PUT", "DELETE"],
        credentials: true
    })
);

app.use(express.json({ limit: "1mb" }));

// General API rate limit
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" }
});
app.use("/api", apiLimiter);

// Stricter rate limit for authentication endpoints (brute-force protection)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many authentication attempts, please try again later" }
});

// Serve frontend
app.use(express.static(path.join(__dirname, "../frontend")));

// Home page
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// Health check
app.get("/health", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW()");

        res.json({
            status: "UP",
            database: "Connected",
            time: result.rows[0].now
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            status: "DOWN",
            database: "Disconnected"
        });
    }
});

// ===============================
// USER REGISTRATION
// ===============================

app.post(
    "/api/auth/register",
    authLimiter,
    [
        body("username")
            .trim()
            .isLength({ min: 3, max: 50 })
            .withMessage("Username must be between 3 and 50 characters")
            .matches(/^[a-zA-Z0-9_.-]+$/)
            .withMessage("Username may only contain letters, numbers, underscores, dots and hyphens"),
        body("email")
            .trim()
            .isEmail()
            .withMessage("A valid email is required")
            .normalizeEmail(),
        body("password")
            .isLength({ min: 8 })
            .withMessage("Password must be at least 8 characters")
    ],
    async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
        }

        const { username, email, password } = req.body;

        const existingUser = await pool.query(
            "SELECT id FROM users WHERE username = $1 OR email = $2",
            [username, email]
        );

        if (existingUser.rows.length > 0) {
            return res.status(409).json({
                error: "Username or email already exists"
            });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const result = await pool.query(
            `INSERT INTO users (username, email, password_hash)
             VALUES ($1, $2, $3)
             RETURNING id, username, email, created_at`,
            [username, email, passwordHash]
        );

        res.status(201).json({
            message: "User registered successfully",
            user: result.rows[0]
        });

    } catch (error) {
        next(error);
    }
});

// ===============================
// USER LOGIN
// ===============================

app.post(
    "/api/auth/login",
    authLimiter,
    [
        body("email").trim().isEmail().withMessage("A valid email is required").normalizeEmail(),
        body("password").notEmpty().withMessage("Password is required")
    ],
    async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
        }

        const { email, password } = req.body;

        const result = await pool.query(
            "SELECT id, username, email, password_hash FROM users WHERE email = $1",
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                error: "Invalid email or password"
            });
        }

        const user = result.rows[0];

        const passwordMatch = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!passwordMatch) {
            return res.status(401).json({
                error: "Invalid email or password"
            });
        }

        const token = jwt.sign(
            {
                userId: user.id,
                username: user.username
            },
            process.env.JWT_SECRET,
            {
                expiresIn: "1h"
            }
        );

        res.json({
            message: "Login successful",
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email
            }
        });

    } catch (error) {
        next(error);
    }
});
// ===============================
// JWT AUTHENTICATION MIDDLEWARE
// ===============================

function authenticateToken(req, res, next) {
    const authHeader = req.headers["authorization"];

    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({
            error: "Access token required"
        });
    }

    jwt.verify(token, process.env.JWT_SECRET, (error, user) => {
        if (error) {
            return res.status(403).json({
                error: "Invalid or expired token"
            });
        }

        req.user = user;
        next();
    });
}
// ===============================
// CREATE ARTICLE
// ===============================

app.post(
    "/api/articles",
    authenticateToken,
    [
        body("title").trim().isLength({ min: 1, max: 255 }).withMessage("Title is required (max 255 characters)"),
        body("content").trim().isLength({ min: 1, max: 50000 }).withMessage("Content is required (max 50,000 characters)"),
        body("cover_image").optional({ nullable: true, checkFalsy: true }).isURL().withMessage("Cover image must be a valid URL")
    ],
    async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
        }

        const { title, content, cover_image } = req.body;

        // Create URL-friendly slug, with a short random suffix to avoid collisions
        const baseSlug = title
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
        const slug = `${baseSlug}-${Date.now().toString(36)}`;

        // Save article
        const result = await pool.query(
            `INSERT INTO articles
            (author_id, title, slug, content, cover_image)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, author_id, title, slug, content, cover_image, created_at`,
            [
                req.user.userId,
                title,
                slug,
                content,
                cover_image || null
            ]
        );

        res.status(201).json({
            message: "Article created successfully",
            article: result.rows[0]
        });

    } catch (error) {
        next(error);
    }
});
// ===============================
// GET ALL ARTICLES
// ===============================

app.get("/api/articles", async (req, res, next) => {
    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const offset = (page - 1) * limit;

        const result = await pool.query(
            `SELECT
                articles.id,
                articles.title,
                articles.slug,
                articles.content,
                articles.cover_image,
                articles.created_at,
                users.id AS author_id,
                users.username AS author
            FROM articles
            JOIN users ON articles.author_id = users.id
            ORDER BY articles.created_at DESC
            LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        const countResult = await pool.query("SELECT COUNT(*) FROM articles");
        const total = parseInt(countResult.rows[0].count, 10);

        res.json({
            articles: result.rows,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        next(error);
    }
});

// ===============================
// 404 HANDLER
// ===============================

app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
});

// ===============================
// CENTRALIZED ERROR HANDLER
// ===============================

app.use((error, req, res, next) => {
    console.error("Unhandled error:", error);

    // Never leak internal error details/stack traces to the client
    res.status(error.status || 500).json({
        error: "Internal server error"
    });
});

// ===============================
// START SERVER
// ===============================

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});

// Graceful shutdown on SIGTERM/SIGINT (important for containers / orchestrators)
function shutdown(signal) {
    console.log(`${signal} received: closing server gracefully`);
    server.close(async () => {
        try {
            await pool.end();
            console.log("Database pool closed. Exiting.");
            process.exit(0);
        } catch (err) {
            console.error("Error during shutdown:", err);
            process.exit(1);
        }
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
