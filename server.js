require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { nanoid } = require("nanoid");
const validUrl = require("valid-url");
const prisma = require("./db");
const { generateQRCodeSVG, generateQRCodeDataURL } = require("./qr");

const app = express();

// --- Configure CORS ---
const allowedOrigins = [
    process.env.FRONTEND_URL,
    "http://localhost:3000",
    "http://127.0.0.1:3000"
].filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (e.g. mobile apps, curl, server-to-server) or allowed origins
        if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
            return callback(null, true);
        }
        return callback(null, true); // Permissive in dev to avoid CORS blocking
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}));

app.use(express.json());

// --- Edge case: malformed JSON body ---
app.use((err, req, res, next) => {
    if ((err instanceof SyntaxError && err.status === 400 && "body" in err) || err.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Invalid JSON in request body" });
    }
    next(err);
});

// Helper: generate a unique short code with retry on collision
async function generateUniqueShortCode(maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        const code = nanoid(6);
        const existing = await prisma.url.findUnique({ where: { shortCode: code } });
        if (!existing) return code;
    }
    throw new Error("Failed to generate a unique short code after several attempts");
}

// Root endpoint
app.get("/", (req, res) => {
    res.json({ message: "URL Shortener API is running with QR support" });
});

// Create short URL (returns shortUrl + qrCode Data URI)
app.post("/api/shorten", async (req, res) => {
    try {
        let { originalUrl } = req.body;

        // --- Edge case: missing field or non-string ---
        if (!originalUrl || typeof originalUrl !== "string") {
            return res.status(400).json({ error: "originalUrl is required and must be a string" });
        }

        // --- Edge case: trim whitespace and empty string ---
        originalUrl = originalUrl.trim();
        if (originalUrl.length === 0) {
            return res.status(400).json({ error: "originalUrl cannot be empty" });
        }

        // --- Edge case: missing protocol -> auto-prefix if valid domain format ---
        if (!/^https?:\/\//i.test(originalUrl)) {
            if (!originalUrl.includes(".") && !originalUrl.toLowerCase().startsWith("localhost")) {
                return res.status(400).json({ error: "originalUrl is not a valid URL" });
            }
            originalUrl = "https://" + originalUrl;
        }

        // --- Edge case: validate URL structure ---
        try {
            const parsed = new URL(originalUrl);
            if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || (!parsed.hostname.includes(".") && parsed.hostname !== "localhost")) {
                return res.status(400).json({ error: "originalUrl is not a valid URL" });
            }
        } catch {
            return res.status(400).json({ error: "originalUrl is not a valid URL" });
        }

        if (!validUrl.isWebUri(originalUrl)) {
            return res.status(400).json({ error: "originalUrl is not a valid URL" });
        }

        // --- Edge case: extremely long URLs (DB safety) ---
        if (originalUrl.length > 2048) {
            return res.status(400).json({ error: "originalUrl is too long (max 2048 characters)" });
        }

        const shortCode = await generateUniqueShortCode();

        const newUrl = await prisma.url.create({
            data: { shortCode, originalUrl }
        });

        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
        const shortUrl = `${baseUrl}/${newUrl.shortCode}`;
        const qrCodeDataUrl = generateQRCodeDataURL(shortUrl);

        res.status(201).json({
            shortCode: newUrl.shortCode,
            shortUrl,
            originalUrl: newUrl.originalUrl,
            qrCode: qrCodeDataUrl
        });
    } catch (err) {
        console.error("Error creating short URL:", err);
        res.status(500).json({ error: "Something went wrong while creating the short URL" });
    }
});

// Dedicated QR code generation endpoint: GET /api/qr/:code or GET /:code/qr
app.get(["/api/qr/:code", "/:code/qr"], async (req, res) => {
    try {
        const { code } = req.params;

        if (!/^[a-zA-Z0-9_-]{1,20}$/.test(code)) {
            return res.status(400).json({ error: "Invalid short code format" });
        }

        const found = await prisma.url.findUnique({ where: { shortCode: code } });
        if (!found) {
            return res.status(404).json({ error: "Short URL not found" });
        }

        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
        const shortUrl = `${baseUrl}/${found.shortCode}`;

        if (req.query.format === "json") {
            return res.json({
                shortCode: found.shortCode,
                shortUrl,
                qrCode: generateQRCodeDataURL(shortUrl)
            });
        }

        // Return SVG image directly
        const svg = generateQRCodeSVG(shortUrl);
        res.setHeader("Content-Type", "image/svg+xml");
        if (req.query.download === "true") {
            res.setHeader("Content-Disposition", `attachment; filename="qr-${found.shortCode}.svg"`);
        }
        res.send(svg);
    } catch (err) {
        console.error("Error generating QR code:", err);
        res.status(500).json({ error: "Something went wrong while generating QR code" });
    }
});

// Redirect short URL -> original
app.get("/:code", async (req, res) => {
    try {
        const { code } = req.params;

        // --- Edge case: reject obviously invalid short codes early ---
        if (!/^[a-zA-Z0-9_-]{1,20}$/.test(code)) {
            return res.status(400).json({ error: "Invalid short code format" });
        }

        const found = await prisma.url.findUnique({ where: { shortCode: code } });

        if (!found) {
            return res.status(404).json({ error: "Short URL not found" });
        }

        res.redirect(found.originalUrl);
    } catch (err) {
        console.error("Error during redirect:", err);
        res.status(500).json({ error: "Something went wrong while redirecting" });
    }
});

// --- Edge case: unknown routes ---
app.use((req, res) => {
    res.status(404).json({ error: "Route not found" });
});

// --- Edge case: catch-all error handler (last resort) ---
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});