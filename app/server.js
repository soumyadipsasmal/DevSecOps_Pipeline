require("dotenv").config();

const express = require("express");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("./db");

const app = express();
const PORT = process.env.PORT || 3007;

// Middleware
app.use(express.json());

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

app.post("/api/auth/register", async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({
                error: "Username, email and password are required"
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                error: "Password must be at least 6 characters"
            });
        }

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
        console.error("Registration error:", error);

        res.status(500).json({
            error: "Internal server error"
        });
    }
});

// ===============================
// USER LOGIN
// ===============================

app.post("/api/auth/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                error: "Email and password are required"
            });
        }

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
        console.error("Login error:", error);

        res.status(500).json({
            error: "Internal server error"
        });
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

app.post("/api/articles", authenticateToken, async (req, res) => {
    try {
        const { title, content, cover_image, category_id } = req.body;

        // Validate input
        if (!title || !content) {
            return res.status(400).json({
                error: "Title and content are required"
            });
        }

        // Create URL-friendly slug
        const slug = title
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");

        // Save article
        const result = await pool.query(
            `INSERT INTO articles
            (author_id, title, slug, content, cover_image, category_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, author_id, title, slug, content, cover_image, category_id, created_at`,
            [
                req.user.userId,
                title,
                slug,
                content,
                cover_image || null,
                category_id || null
            ]
        );

        res.status(201).json({
            message: "Article created successfully",
            article: result.rows[0]
        });

    } catch (error) {
        console.error("Article creation error:", error);

        res.status(500).json({
            error: "Internal server error"
        });
    }
});
// ===============================
// GET CATEGORIES
// ===============================

app.get("/api/categories", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, name, slug FROM categories ORDER BY display_order ASC, name ASC"
        );
        res.json({ categories: result.rows });
    } catch (error) {
        console.error("Get categories error:", error);
        res.json({ categories: [] });
    }
});

// ===============================
// GET ALL ARTICLES
// ===============================

app.get("/api/articles", async (req, res) => {
    try {
        const { search, category, trending } = req.query;

        let query = `
            SELECT
                articles.id,
                articles.title,
                articles.slug,
                articles.content,
                LEFT(articles.content, 200) AS excerpt,
                articles.cover_image,
                articles.is_featured,
                articles.is_trending,
                articles.status,
                articles.published_at,
                articles.created_at,
                users.id AS author_id,
                users.username AS author_username,
                users.avatar_url AS author_avatar,
                users.bio AS author_bio,
                categories.name AS category_name,
                categories.slug AS category_slug
            FROM articles
            JOIN users ON articles.author_id = users.id
            LEFT JOIN categories ON articles.category_id = categories.id
        `;

        const conditions = [];
        const params = [];

        if (search) {
            params.push(`%${search}%`);
            conditions.push(`(articles.title ILIKE $${params.length} OR articles.content ILIKE $${params.length})`);
        }

        if (category) {
            params.push(category);
            conditions.push(`categories.slug = $${params.length}`);
        }

        if (trending === "true") {
            conditions.push(`articles.is_trending = true`);
        }

        if (conditions.length > 0) {
            query += " WHERE " + conditions.join(" AND ");
        }

        query += " ORDER BY articles.created_at DESC LIMIT 50";

        const result = await pool.query(query, params);
        res.json({ articles: result.rows });

    } catch (error) {
        console.error("Get articles error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ===============================
// GET SINGLE ARTICLE
// ===============================

app.get("/api/articles/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT
                articles.id,
                articles.title,
                articles.slug,
                articles.content,
                articles.cover_image,
                articles.is_featured,
                articles.is_trending,
                articles.status,
                articles.published_at,
                articles.created_at,
                users.id AS author_id,
                users.username AS author_username,
                users.avatar_url AS author_avatar,
                users.bio AS author_bio,
                categories.name AS category_name,
                categories.slug AS category_slug
            FROM articles
            JOIN users ON articles.author_id = users.id
            LEFT JOIN categories ON articles.category_id = categories.id
            WHERE articles.id = $1
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Article not found" });
        }

        res.json(result.rows[0]);

    } catch (error) {
        console.error("Get article error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});
// ===============================
// START SERVER
// ===============================

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
