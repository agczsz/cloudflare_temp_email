import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import { createMailer, normalizeFrom, renderStructuredMessage } from "./src/sendmail.ts";

const address = "mailbox@example.test";
const sender = { email: address, name: "MyGo Emby Bot" };

const getHeader = (raw, name) => {
    const text = Buffer.from(raw).toString("utf8");
    return text.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`)) || "";
};

test("normalizes Worker sender objects for Nodemailer and emits a valid From header", async () => {
    const from = normalizeFrom(sender);
    assert.deepEqual(from, { address, name: "MyGo Emby Bot" });
    const renderer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "normalize" });
    const raw = await renderStructuredMessage(renderer, {
        from: sender,
        to: "recipient@example.test",
        subject: "sender normalization regression",
        text: "body",
    });
    const header = getHeader(raw, "From");
    assert.match(header, /MyGo Emby Bot/);
    assert.match(header, /mailbox@example\.test/);
});

test("relay send receives normalized from object", async () => {
    let relayMessage;
    const relay = {
        sendMail: async (message) => {
            relayMessage = message;
            return { accepted: ["recipient@example.test"] };
        },
    };
    const mailer = createMailer({
        DOMAINS: ["example.test"],
        SEND_RELAY_HOST: "relay.example.test",
        SEND_RELAY_PORT: 587,
    }, undefined, (options) => {
        assert.equal(options.host, "relay.example.test");
        return relay;
    });
    await mailer.sendMail({
        from: sender,
        to: "recipient@example.test",
        subject: "relay sender normalization regression",
        text: "body",
    });
    assert.deepEqual(relayMessage.from, { address, name: "MyGo Emby Bot" });
});

test("raw MIME bytes and its From header are passed through unchanged", async () => {
    const raw = Buffer.from(
        "From: MyGo Emby Bot <mailbox@example.test>\r\n" +
        "To: recipient@example.test\r\n" +
        "Subject: raw passthrough\r\n\r\nbody\r\n",
    );
    let sentMessage;
    const mailer = createMailer({ DOMAINS: ["example.test"] }, undefined, (options) => {
        if (options.streamTransport) return nodemailer.createTransport(options);
        return {
            sendMail: async (message) => {
                sentMessage = message;
                return { accepted: ["recipient@example.test"] };
            },
        };
    });

    // Use a recipient domain with a deterministic local MX lookup by stubbing DNS.
    const dns = await import("node:dns");
    const originalResolveMx = dns.promises.resolveMx;
    dns.promises.resolveMx = async () => [{ priority: 10, exchange: "mx.example.test" }];
    try {
        await mailer.sendMail({
            from: "mailbox@example.test",
            to: "recipient@example.test",
            raw,
        });
    } finally {
        dns.promises.resolveMx = originalResolveMx;
    }
    assert.deepEqual(sentMessage.raw, raw);
    assert.equal(getHeader(sentMessage.raw, "From"), getHeader(raw, "From"));
});
