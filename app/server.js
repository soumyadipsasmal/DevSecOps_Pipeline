const express = require("express");
const path = require("path");

const app = express();
const PORT = 3007;

// Serve frontend files
app.use(express.static(path.join(__dirname, "../frontend")));

// Health check
app.get("/health", (req, res) => {
    res.json({
        status: "UP",
        message: "Application is healthy"
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
