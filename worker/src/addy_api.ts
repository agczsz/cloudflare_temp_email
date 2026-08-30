import { Hono } from 'hono'
import { newAddress, getAddressPrefix, generateRandomName } from './common'
import { getDomains } from './utils'

/**
 * Bitwarden compatibility module (Addy.io anon-addy protocol subset).
 *
 * Bitwarden's username generator supports Addy.io as an email forwarder. With
 * this module the temp-email server speaks just enough of that protocol to let
 * Bitwarden create throwaway mailboxes on this server (same idea as
 * Yeqingky/Seek2Addy, but backed by this server's own address creation).
 *
 * Contract (what Bitwarden sends for Addy.io self-hosted):
 *   POST /api/v1/aliases
 *   Authorization: Bearer <ADDY_AUTH_TOKEN>   (the "API key" in Bitwarden UI)
 *   {"domain": "...", "description": "..."}   (description is ignored, a
 *                                              random local part is generated)
 *   -> 200 {"data": {"email": "xxxx@266666.best"}}
 *
 * Enable by setting ADDY_AUTH_TOKEN in config.json / TE_ADDY_AUTH_TOKEN; when
 * unset the endpoint answers 403 and is inert. The address itself is created
 * through the exact same newAddress() helper /api/new_address uses, so all
 * upstream validation (prefix, regex, length, block list) applies unchanged.
 */
export const api = new Hono<HonoCustomType>();

api.use('/api/v1/*', async (c, next) => {
    const token = c.env.ADDY_AUTH_TOKEN;
    if (!token) {
        return c.text('Addy.io compatible API is disabled (ADDY_AUTH_TOKEN not set)', 403);
    }
    const auth = c.req.header('Authorization') || '';
    if (auth !== `Bearer ${token}`) {
        return c.text('Unauthorized', 401);
    }
    await next();
});

api.post('/api/v1/aliases', async (c) => {
    let body: any = {};
    try {
        body = await c.req.json();
    } catch {
        /* body is optional for us */
    }
    const domains = getDomains(c);
    const domain = typeof body?.domain === 'string' && domains.includes(body.domain)
        ? body.domain
        : domains[0];
    if (!domain) {
        return c.text('No domain configured', 400);
    }
    const name = generateRandomName(c);
    const res = await newAddress(c, {
        name,
        domain,
        enablePrefix: true,
        enableRandomSubdomain: false,
        checkLengthByConfig: true,
        addressPrefix: await getAddressPrefix(c),
        sourceMeta: 'bitwarden-addy',
    });
    return c.json({ data: { email: res.address } });
});
