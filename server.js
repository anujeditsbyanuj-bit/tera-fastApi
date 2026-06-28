require('dotenv').config(); // Load environment variables
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const UserAgent = require('user-agents');

const app = express();
app.use(express.json());

// ==========================================
// 1. MONGODB ATLAS CONNECTION & SCHEMAS
// ==========================================
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('❌ FATAL ERROR: MONGO_URI is not defined in .env');
    process.exit(1);
}

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

const KeySchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    usageCount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }
});
const ApiKey = mongoose.model('ApiKey', KeySchema);

const MetadataSchema = new mongoose.Schema({
    originalUrl: { type: String, required: true, index: true },
    fileData: { type: Object, required: true },
    fetchedAt: { type: Date, default: Date.now }
});
const Metadata = mongoose.model('Metadata', MetadataSchema);

// ==========================================
// 2. ATOMIC API KEY ROTATION LOGIC
// ==========================================
async function getValidApiKey() {
    const keyDoc = await ApiKey.findOneAndUpdate(
        { isActive: true, usageCount: { $lt: 100 } },
        { $inc: { usageCount: 1 } },
        { new: true }
    );

    if (!keyDoc) {
        throw new Error("API Key pool exhausted.");
    }

    if (keyDoc.usageCount >= 100) {
        keyDoc.isActive = false;
        await keyDoc.save();
        console.log(`⚠️ Key rotated: ${keyDoc.key.substring(0, 8)}*** reached 100 requests.`);
    }

    return keyDoc.key;
}

// ==========================================
// 3. CORE API CONTROLLER (Handles GET & POST)
// ==========================================
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 Hours

const fetchTeraboxHandler = async (req, res) => {
    const url = req.method === 'GET' ? req.query.url : req.body.url;

    if (!url || !url.includes('terabox')) {
        return res.status(400).json({ status: "error", message: "Valid TeraBox URL is required" });
    }

    try {
        // STEP 1: Check Cache
        const cachedRecord = await Metadata.findOne({ originalUrl: url });

        if (cachedRecord) {
            const timeSinceFetch = Date.now() - cachedRecord.fetchedAt.getTime();
            
            if (timeSinceFetch < CACHE_TTL_MS) {
                return res.json({
                    status: "success",
                    data: cachedRecord.fileData,
                    _meta: { source: "cache", age_minutes: Math.round(timeSinceFetch / 60000) }
                });
            } else {
                await Metadata.deleteOne({ _id: cachedRecord._id });
            }
        }

        // STEP 2: Fetch Fresh Data
        const currentKey = await getValidApiKey();
        const userAgent = new UserAgent({ deviceCategory: 'desktop' }).toString();

        const response = await axios.post(
            "https://xapiverse.com/api/terabox-pro",
            { url: url },
            {
                headers: {
                    "Content-Type": "application/json",
                    "xAPIverse-Key": currentKey,
                    "User-Agent": userAgent
                },
                timeout: 8000
            }
        );

        const data = response.data;

        if (data.status === "success" && data.list && data.list.length > 0) {
            const fileData = data.list[0];

            // STEP 3: Save to Cache Asynchronously
            Metadata.create({
                originalUrl: url,
                fileData: fileData, 
                fetchedAt: Date.now()
            }).catch(err => console.error("Cache Save Error:", err));

            return res.json({
                status: "success",
                data: fileData,
                _meta: { source: "live_api", key_used: currentKey.substring(0, 8) + '***' }
            });
        } else {
            return res.status(400).json({ status: "error", message: "Failed to extract link", upstream_response: data });
        }

    } catch (error) {
        const errorMsg = error.response ? error.response.data : error.message;
        return res.status(500).json({ status: "error", message: errorMsg });
    }
};

app.get('/api/fetch-terabox', fetchTeraboxHandler);
app.post('/api/fetch-terabox', fetchTeraboxHandler);

// ==========================================
// 4. ADMIN ENDPOINT: ADD NEW API KEYS
// ==========================================
app.post('/admin/add-keys', async (req, res) => {
    const { keys } = req.body; 
    try {
        const docs = keys.map(k => ({ key: k, usageCount: 0, isActive: true }));
        await ApiKey.insertMany(docs, { ordered: false });
        res.json({ status: "success", message: `${keys.length} keys added.` });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ==========================================
// 5. LIVE HEALTH CHECK ENDPOINT (/health)
// ==========================================
app.get('/health', async (req, res) => {
    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    const dbStatus = mongoose.connection.readyState === 1 ? "UP" : "DOWN";
    
    let activeKeysCount = 0;
    if (dbStatus === "UP") {
        try {
            activeKeysCount = await ApiKey.countDocuments({ isActive: true, usageCount: { $lt: 100 } });
        } catch (e) {
            console.error("Health check key count failed", e);
        }
    }

    const isHealthy = dbStatus === "UP" && activeKeysCount > 0;

    res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? "healthy" : "unhealthy",
        timestamp: new Date().toISOString(),
        details: {
            database: dbStatus,
            available_keys: activeKeysCount
        }
    });
});

// ==========================================
// 6. DOCUMENTATION ENDPOINT (/docs)
// ==========================================
app.get('/docs', (req, res) => {
    const htmlDocs = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>TeraBox API Documentation</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 2rem; }
            h1 { color: #2c3e50; border-bottom: 2px solid #eee; padding-bottom: 10px; }
            h2 { color: #34495e; margin-top: 30px; }
            .endpoint { background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 5px; padding: 15px; margin-bottom: 20px; }
            .method { display: inline-block; padding: 3px 8px; border-radius: 3px; font-weight: bold; color: white; margin-right: 10px; }
            .get { background: #61affe; }
            .post { background: #49cc90; }
            code { background: #f1f1f1; padding: 2px 5px; border-radius: 3px; font-family: monospace; }
            pre { background: #282c34; color: #abb2bf; padding: 15px; border-radius: 5px; overflow-x: auto; }
        </style>
    </head>
    <body>
        <h1>TeraBox High-Speed API</h1>
        <p>A highly optimized, cached, and load-balanced API for extracting TeraBox metadata and direct download links.</p>

        <h2>Endpoints</h2>

        <div class="endpoint">
            <h3><span class="method get">GET</span> /health</h3>
            <p>Monitors system health, checking database connection status and verifying if valid keys remain.</p>
        </div>

        <div class="endpoint">
            <h3><span class="method get">GET</span> /api/fetch-terabox</h3>
            <p>Extract links by passing the TeraBox URL as a query parameter. Ideal for browser testing.</p>
            <p><strong>Query Parameter:</strong> <code>url</code> (Required)</p>
            <p><strong>Example usage:</strong></p>
            <code>/api/fetch-terabox?url=https://1024terabox.com/s/123abcxyz</code>
        </div>

        <div class="endpoint">
            <h3><span class="method post">POST</span> /api/fetch-terabox</h3>
            <p>Extract links by passing the URL in the JSON body. Ideal for application integrations.</p>
            <p><strong>Headers:</strong> <code>Content-Type: application/json</code></p>
            <p><strong>Request Body:</strong></p>
            <pre>
{
  "url": "https://1024terabox.com/s/123abcxyz"
}
            </pre>
        </div>

        <h2>Response Structure</h2>
        <p>Both GET and POST endpoints return the exact same JSON response format.</p>
        <pre>
{
  "status": "success",
  "data": {
    "name": "video_example.mp4",
    "size": 43162336,
    "quality": "480p",
    "fast_stream_url": { ... },
    "normal_dlink": "..."
  },
  "_meta": {
    "source": "cache",
    "age_minutes": 15
  }
}
        </pre>
    </body>
    </html>
    `;
    res.send(htmlDocs);
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 TeraBox API Server running on http://localhost:${PORT}`));
