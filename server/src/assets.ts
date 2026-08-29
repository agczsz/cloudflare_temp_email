import fs from "node:fs";
import path from "node:path";

/**
 * Stand-in for the Cloudflare Pages ASSETS binding: serves the built frontend
 * (vue dist) from disk. The worker calls `env.ASSETS.fetch(url)` where url
 * already had its pathname cleared for SPA routes, so:
 *   - "" or "/" -> index.html
 *   - existing file -> file contents
 *   - anything else -> 404
 */
const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
};

export function createAssets(distDir: string) {
    return {
        async fetch(input: URL | string | Request): Promise<Response> {
            try {
                const pathname = decodeURIComponent(
                    input instanceof URL ? input.pathname
                        : typeof input === "string" ? input
                            : new URL(input.url).pathname);
                if (!pathname || pathname === "/" || !pathname.includes(".")) {
                    return serveFile(path.join(distDir, "index.html"));
                }
                const rel = path.normalize(pathname).replace(/^([.][.][/\\])+/, "");
                return serveFile(path.join(distDir, rel));
            } catch {
                return new Response("Not Found", { status: 404 });
            }
        },
    };

    function serveFile(fp: string): Response {
        if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
            return new Response("Not Found", { status: 404 });
        }
        const ext = path.extname(fp).toLowerCase();
        return new Response(fs.readFileSync(fp), {
            headers: {
                "content-type": MIME[ext] || "application/octet-stream",
                "cache-control": ext === ".html" ? "no-cache" : "public, max-age=86400",
            },
        });
    }
}
