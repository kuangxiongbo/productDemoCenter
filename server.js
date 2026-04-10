require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const db = require('./src/db/db');
const { PROTOTYPES_ROOT } = require('./src/utils/file-utils');

const app = express();

// ==================== Middleware ====================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
// Specific handlers for Catalog Home Page assets
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));

// Request logging
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
        console.log(`[API Request] ${req.method} ${req.path}`);
    }
    next();
});

// ==================== Trailing Slash Redirect ====================
// Essential for relative asset resolution (./assets/...)
app.use(async (req, res, next) => {
    if (req.method !== 'GET') return next();
    
    const segments = req.path.split('/').filter(Boolean);
    if (segments.length === 1 && !req.path.endsWith('/')) {
        const slug = segments[0];
        if (slug !== 'api' && slug !== 'p') {
            try {
                const proto = await db.getPrototypeBySlug(slug);
                if (proto) {
                    console.log(`[Redirect] Adding trailing slash for slug: /${slug} -> /${slug}/`);
                    return res.redirect(301, `/${slug}/`);
                }
            } catch (e) {}
        }
    }
    next();
});

// ==================== Asset Interceptor ====================
// Maps absolute asset paths back to the correct prototype folder
app.use(async (req, res, next) => {
    // 1. Identify asset requests only
    const isAsset = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|json|wasm)$/i.test(req.path);
    if (!isAsset || req.path.startsWith('/api/')) return next();

    // 2. Identify the origin prototype from Referer or Prefix
    const referer = req.get('Referer');
    let slug = null;

    if (referer) {
        try {
            const refPath = new URL(referer).pathname;
            const segments = refPath.split('/').filter(Boolean);
            if (segments.length > 0 && segments[0] !== 'api' && segments[0] !== 'p') {
                slug = segments[0];
            }
        } catch (e) {}
    }

    // 3. Fallback: Check if the slug is already in the path (e.g., /slug/assets/...)
    if (!slug) {
        const pathSegments = req.path.split('/').filter(Boolean);
        if (pathSegments.length > 1) slug = pathSegments[0];
    }

    if (slug) {
        try {
            const proto = await db.getPrototypeBySlug(slug);
            if (proto) {
                const { isSafePath } = require('./src/utils/file-utils');
                const protoRoot = path.isAbsolute(proto.path) ? proto.path : path.resolve(__dirname, proto.path);
                
                // 🛠️ FIX: Ensure resourcePath is relative to the proto root for isSafePath check
                let resourcePath = req.path;
                if (resourcePath.startsWith(`/${slug}/`)) {
                    resourcePath = resourcePath.substring(slug.length + 2);
                } else if (resourcePath.startsWith(`/${slug}`)) {
                    resourcePath = resourcePath.substring(slug.length + 1);
                }
                
                // Remove any leading slashes to keep path relative for path.resolve in isSafePath
                resourcePath = resourcePath.replace(/^\/+/, '');
                
                // 🔐 Path Traversal Check (Skip if resource is empty as it reflects root access)
                if (resourcePath && !isSafePath(protoRoot, resourcePath)) {
                    console.warn(`[Security] Blocked path traversal attempt: ${req.path}`);
                    return res.status(403).send('Forbidden');
                }

                const searchPaths = [
                    path.join(protoRoot, resourcePath),
                    path.join(protoRoot, 'dist', resourcePath),
                    path.join(protoRoot, 'build', resourcePath),
                    path.join(protoRoot, 'public', resourcePath),
                    // Specific fallback for common SPA asset folders
                    path.join(protoRoot, 'dist/assets', resourcePath),
                    path.join(protoRoot, 'build/assets', resourcePath)
                ];

                for (const p of searchPaths) {
                    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
                        // 🛠️ FIX: Explicitly set MIME types for ESM stability (Vite)
                        const ext = path.extname(p).toLowerCase();
                        if (ext === '.js') res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                        if (ext === '.css') res.setHeader('Content-Type', 'text/css; charset=utf-8');
                        return res.sendFile(p);
                    }
                }
            }
        } catch (e) {
            console.error('[Asset Interceptor] Error:', e.message);
        }
    }
    next();
});

// ==================== API Routes ====================
const orgRouter = require('./src/routes/organizations');
const protoRouter = require('./src/routes/prototypes');

app.use('/api/organizations', orgRouter);
app.use('/api/projects', orgRouter); // Alias for projects/summary
app.use('/api/prototypes', protoRouter);
app.use('/api/tasks', require('./src/routes/tasks'));
app.use('/api/versions', require('./src/routes/versions'));

// Compatibility Aliases for root /api
app.use('/api/upload', (req, res, next) => {
    if (req.method === 'POST') {
        req.url = '/upload';
        return protoRouter(req, res, next);
    }
    next();
});
app.use('/api/git/sync', (req, res, next) => {
    if (req.method === 'POST') {
        req.url = '/git-sync-global';
        return protoRouter(req, res, next);
    }
    next();
});

// ==================== Serving Prototypes ====================

// Helper to send HTML with dynamic base path injection
function sendHtmlWithInjection(res, filePath, basePath) {
    if (fs.existsSync(filePath)) {
        try {
            let html = fs.readFileSync(filePath, 'utf8');
            const injectScript = `<script>window.getBasePath = function() { return '${basePath}'; };</script>\n</head>`;
            html = html.replace('</head>', injectScript);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(html);
        } catch (e) {
            return res.sendFile(filePath);
        }
    }
    return false;
}

// Serve by Slug (Directory Entry Point)
app.get('/:slug', async (req, res, next) => {
    const { slug } = req.params;
    if (slug === 'api' || slug === 'p' || slug.includes('.')) return next();

    try {
        const proto = await db.getPrototypeBySlug(slug);
        if (!proto) return next();

        // 1. Force trailing slash to aid relative path resolution in browsers
        if (!req.path.endsWith('/')) {
            return res.redirect(301, `${req.path}/`);
        }

        // 2. Serve the index file
        const protoRoot = path.isAbsolute(proto.path) ? proto.path : path.resolve(__dirname, proto.path);
        const indexPath = path.join(protoRoot, proto.indexFile || 'index.html');

        if (sendHtmlWithInjection(res, indexPath, `/${slug}`)) return;
    } catch (e) {}
    next();
});

// Serve nested sub-paths for Slug
app.get('/:slug/*', async (req, res, next) => {
    const { slug } = req.params;
    if (slug === 'api' || slug === 'p') return next();

    try {
        const proto = await db.getPrototypeBySlug(slug);
        if (!proto) return next();

        const resourcePath = req.params[0];
        const protoRoot = path.isAbsolute(proto.path) ? proto.path : path.resolve(__dirname, proto.path);
        
        // Search in root, dist, build folders
        const searchPaths = [
            path.join(protoRoot, resourcePath),
            path.join(protoRoot, 'dist', resourcePath),
            path.join(protoRoot, 'build', resourcePath),
            path.join(protoRoot, 'public', resourcePath)
        ];

        for (const p of searchPaths) {
            if (fs.existsSync(p) && fs.statSync(p).isFile()) {
                if (p.endsWith('.html')) {
                    if (sendHtmlWithInjection(res, p, `/${slug}`)) return;
                }
                return res.sendFile(p);
            }
        }
        
        // 3. Fallback for SPA Routing (History Mode)
        // If it's not a file (like an API request or static asset) and it doesn't match an actual file, 
        // try to serve the prototype's index.html again so the client-side router can handle it.
        const isLikelyAsset = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|json|wasm)$/i.test(req.path);
        if (!isLikelyAsset) {
            const indexPath = path.join(protoRoot, proto.indexFile || 'index.html');
            if (sendHtmlWithInjection(res, indexPath, `/${slug}`)) return;
        }
    } catch (e) {}
    next();
});

// Serve by ID (Direct)
app.get('/p/:id', async (req, res, next) => {
    try {
        const proto = await db.getPrototypeById(req.params.id);
        if (!proto) return next();

        const protoRoot = path.isAbsolute(proto.path) ? proto.path : path.resolve(__dirname, proto.path);
        const indexPath = path.join(protoRoot, proto.indexFile || 'index.html');

        if (sendHtmlWithInjection(res, indexPath, `/p/${req.params.id}`)) return;
    } catch (e) {}
    next();
});

// Default index
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==================== Startup ====================
(async () => {
    try {
        await db.init();
        console.log('[Server] 数据库架构初始化完成');
        
        const PORT = process.env.PORT || 4000;
        app.listen(PORT, () => {
            console.log(`[Server] Prototype Center running on http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('[Server] 启动失败，数据库初始化异常:', err);
        process.exit(1);
    }
})();
