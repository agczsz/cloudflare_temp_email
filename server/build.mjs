import { build } from "esbuild";

/**
 * Cloudflare runtime module stubs. `cloudflare:sockets` is required at module
 * top level by worker-mailer, so an unresolvable import would crash the whole
 * bundle at load time even when the feature is never used. The stubs throw
 * only when the feature is actually exercised.
 */
const CF_STUBS = {
    "cloudflare:sockets": `export function connect() { throw new Error("cloudflare:sockets is not available on the Node server runtime"); }
export default { connect };`,
    "cloudflare:email": `export class EmailMessage {
    constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; }
    setReject(reason) {}
}
export default { EmailMessage };`,
};

const cfStubPlugin = {
    name: "cf-stubs",
    setup(b) {
        b.onResolve({ filter: /^cloudflare:/ }, (args) => ({ path: args.path, namespace: "cf-stub" }));
        b.onLoad({ filter: /.*/, namespace: "cf-stub" }, (args) => ({
            contents: CF_STUBS[args.path] || "export default {};",
            loader: "js",
        }));
    },
};

/**
 * Bundle the worker code + node adapter into a single ESM file.
 * Runtime deps stay external: better-sqlite3 is native, @aws-sdk/* is huge and
 * only needed for the optional S3 attachment feature, @hono/node-server is the
 * HTTP glue. `npm install --omit=dev` on the target host provides them.
 */
await build({
    entryPoints: ["src/entry.ts"],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: "dist/server.js",
    external: ["better-sqlite3", "@aws-sdk/*", "@hono/node-server"],
    loader: {
        // mail-parser-wasm-worker imports the wasm as a module; inline it as
        // bytes so initSync can compile it under plain Node
        ".wasm": "binary",
    },
    plugins: [cfStubPlugin],
    banner: {
        js: [
            "import { createRequire as __createRequire } from 'node:module';",
            "const require = __createRequire(import.meta.url);",
        ].join("\n"),
    },
    minify: false,
    sourcemap: false,
    logLevel: "info",
});
