import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import { startSmtpServer } from "./src/smtp.ts";

test("SMTP messages dispatch forwards and auto-replies through the VPS adapter", async () => {
    let forwarded;
    let replied;
    const server = startSmtpServer({
        port: 0,
        host: "127.0.0.1",
        allowedDomains: ["example.test"],
        onMessage: async (message) => {
            await message.forward("forward@example.net");
            await message.reply({
                from: "inbox@example.test",
                to: "sender@example.net",
                raw: Buffer.from("From: inbox@example.test\r\n\r\nauto reply\r\n"),
            });
        },
        forward: async (message, rcptTo) => {
            forwarded = { ...message, rcptTo };
        },
        reply: async (message) => {
            replied = message;
        },
    });
    const client = nodemailer.createTransport({
        host: "127.0.0.1",
        port: await new Promise((resolve, reject) => {
            server.server.once("listening", () => resolve(server.server.address().port));
            server.server.once("error", reject);
        }),
        secure: false,
        tls: { rejectUnauthorized: false },
    });

    try {
        await client.sendMail({
            from: "sender@example.net",
            to: "inbox@example.test",
            subject: "adapter forwarding test",
            text: "original message",
        });

        assert.equal(forwarded.from, "sender@example.net");
        assert.equal(forwarded.to, "inbox@example.test");
        assert.equal(forwarded.rcptTo, "forward@example.net");
        assert.match(Buffer.from(forwarded.raw).toString("utf8"), /original message/);
        assert.equal(replied.from, "inbox@example.test");
        assert.equal(replied.to, "sender@example.net");
        assert.match(Buffer.from(replied.raw).toString("utf8"), /auto reply/);
    } finally {
        client.close();
        await new Promise((resolve) => server.close(resolve));
    }
});
