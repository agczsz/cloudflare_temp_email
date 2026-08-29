/**
 * In-memory fixed-window rate limiter standing in for the Workers
 * RATE_LIMITER binding: .limit({ key }) -> { success: boolean }.
 * Counts are per process lifetime (reset on restart), which is fine for the
 * light anti-abuse purpose of /api/new_address and send_mail endpoints.
 */
export function createRateLimiter(cfg: { RATE_LIMIT_COUNT?: number; RATE_LIMIT_PERIOD?: number }) {
    const limit = Number(cfg.RATE_LIMIT_COUNT || 60);
    const periodMs = Number(cfg.RATE_LIMIT_PERIOD || 60) * 1000;
    const hits = new Map<string, { count: number; resetAt: number }>();

    return {
        async limit({ key }: { key: string }): Promise<{ success: boolean }> {
            const now = Date.now();
            const entry = hits.get(key);
            if (!entry || entry.resetAt <= now) {
                hits.set(key, { count: 1, resetAt: now + periodMs });
                return { success: true };
            }
            entry.count += 1;
            if (entry.count > limit) {
                return { success: false };
            }
            return { success: true };
        },
    };
}
