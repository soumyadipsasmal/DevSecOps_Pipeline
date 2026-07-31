const express = require("express");

const app = express();
const PORT = 3007;

app.get("/", (req, res) => {
    res.send("DevSecOps Pipeline Application is Running!");
});

app.get("/health", (req, res) => {
    res.json({
        status: "UP",
        message: "Application is healthy"
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
