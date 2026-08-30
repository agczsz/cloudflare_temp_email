/**
 * Cloudflare Workers AI binding replacement.
 *
 * The worker code calls `env.AI.run(model, inputs)`. On a VPS we translate that
 * to the public Workers AI REST API. Fill in AI_API_KEY + AI_ACCOUNT_ID in
 * config.json (an API token with Workers AI permission); when either is empty
 * the binding stays undefined and the worker automatically falls back to its
 * built-in regex extraction, so the deployment works without any key.
 */
export interface WorkersAiRestConfig {
    AI_API_KEY?: string;
    AI_ACCOUNT_ID?: string;
}

export function createAiBinding(cfg: WorkersAiRestConfig) {
    if (!cfg.AI_API_KEY || !cfg.AI_ACCOUNT_ID) {
        return undefined;
    }
    const base = cfg.AI_BASE_URL || "https://api.cloudflare.com/client/v4";
    return {
        async run(model: string, inputs: any): Promise<any> {
            const resp = await fetch(
                `${base}/accounts/${cfg.AI_ACCOUNT_ID}/ai/run/${model}`,
                {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${cfg.AI_API_KEY}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(inputs),
                });
            const data: any = await resp.json();
            if (!resp.ok || data.success === false) {
                throw new Error(`Workers AI REST error: ${JSON.stringify(data.errors ?? data)}`);
            }
            return data.result;
        },
    };
}
