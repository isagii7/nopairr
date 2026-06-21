import express from "express";
import fs from "fs";
import pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pn from "awesome-phonenumber";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

// ===== براہِ راست کریڈنشلز سے سیشن سٹرنگ بنائیں =====
function getSessionString(creds) {
    try {
        const base64Creds = Buffer.from(JSON.stringify(creds)).toString('base64');
        return `NEXTY-MD~${base64Creds}`;
    } catch (error) {
        console.error("Error encoding creds:", error);
        return null;
    }
}

function rm(p) {
    try { 
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); 
    } catch(e) {
        console.log("Cleanup error:", e);
    }
}

router.get("/", async (req, res) => {
    let num = (req.query.number || "").replace(/[^0-9]/g, "");
    if (!num) return res.status(400).send({ code: "Number required" });

    const phone = pn("+" + num);
    if (!phone.isValid()) return res.status(400).send({ code: "Invalid number" });
    num = phone.getNumber("e164").replace("+", "");

    const dir = "./session" + num;
    rm(dir);

    let sessionSent = false;
    let sock;

    async function sendSessionNow() {
        if (sessionSent) return;
        sessionSent = true;
        console.log("✅ Sending session now...");
        try {
            const jid = jidNormalizedUser(num + "@s.whatsapp.net");
            const sessionString = getSessionString(sock.authState.creds);
            if (!sessionString) throw new Error("Failed to encode creds");

            // 1️⃣ سیشن سٹرنگ فوراً بھیجیں
            await sock.sendMessage(jid, { text: sessionString });
            console.log("✅ Session string sent to user");

            // 2️⃣ بوٹ کی معلومات (تھوڑی تاخیر کے ساتھ)
            await delay(1000);
            const fakeVCardQuoted = {
                key: {
                    fromMe: false,
                    participant: "0@s.whatsapp.net",
                    remoteJid: "status@broadcast"
                },
                message: {
                    contactMessage: {
                        displayName: "© NEXTY-MD",
                        vcard: `BEGIN:VCARD
VERSION:3.0
FN:© NEXTY-MD
ORG:NEXTY FORWARD;
TEL;type=CELL;type=VOICE;waid=13135550002:+13135550002
END:VCARD`
                    }
                }
            };

            const caption = `
╭─［ *ᴘᴏᴡᴇʀᴇᴅ ʙʏ ɴᴇxᴛʏ-ᴍᴅ* ］─··╮
│★╭─────────────────────╮
│★│ 👑 Owner : *NEXTY FORWARD*
│★│ 🤖 Baileys : *Multi Device*
│★│ 💻 Type : *NodeJs*
│★│ 🚀 Platform : *Render*
│★│ ⚙️ Mode : *Public*
│★│ 🔣 Prefix : *[ . ]*
│★│ 🏷️ Version : *8.0.0*
│★│ 🔗 Channel : https://whatsapp.com/channel/0029Vb8mDiBCHDytzXwk1o0K
│★╰─────────────────────╯
╰─────────────────────╯`;

            await sock.sendMessage(
                jid,
                {
                    image: { url: "https://files.catbox.moe/93fe56.jpg" },
                    caption,
                    contextInfo: {
                        mentionedJid: [jid],
                        forwardingScore: 999,
                        isForwarded: true,
                        forwardedNewsletterMessageInfo: {
                            newsletterJid: "116505769414861@lid",
                            newsletterName: "NEXTY-MD",
                            serverMessageId: 143
                        }
                    }
                },
                { quoted: fakeVCardQuoted }
            );
            console.log("✅ Bot info sent to user");

            await delay(1000);
            rm(dir);
            console.log("✅ Session cleaned up");
            sock.end();
        } catch (err) {
            console.error("❌ Error in sending session:", err);
            rm(dir);
            sock.end();
        }
    }

    async function start() {
        const { state, saveCreds } = await useMultiFileAuthState(dir);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            logger: pino({ level: "fatal" }),
            browser: Browsers.windows("Chrome"),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
        });

        sock.ev.on("creds.update", saveCreds);

        // ✅ صرف connection.open پر سیشن بھیجیں
        sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
            console.log(`🔄 Connection update: ${connection}`);
            if (connection === "open" && !sessionSent) {
                console.log("✅ Connection open! Sending session...");
                await sendSessionNow();
            }

            if (connection === "close") {
                const c = lastDisconnect?.error?.output?.statusCode;
                if (c === 401) {
                    console.log("❌ Unauthorized — pairing failed");
                } else {
                    console.log("🔁 Connection closed — cleaning up");
                }
                if (!sessionSent) {
                    rm(dir);
                    sock.end();
                }
            }
        });

        // پئیرنگ کوڈ درخواست کریں
        if (!sock.authState.creds.registered) {
            await delay(3000);
            try {
                let code = await sock.requestPairingCode(num);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                if (!res.headersSent) {
                    res.send({ 
                        success: true, 
                        code: code,
                        message: "Enter this code in WhatsApp Web to connect" 
                    });
                }
                console.log(`✅ Pairing code sent: ${code}`);

                // ⏱️ ٹائم آؤٹ: اگر 40 سیکنڈ میں open نہ آئے تو صفائی
                setTimeout(() => {
                    if (!sessionSent) {
                        console.log("⏰ Timeout: No connection open. Cleaning up.");
                        rm(dir);
                        sock.end();
                    }
                }, 40000);
            } catch(err) {
                console.error("Pairing error:", err);
                if (!res.headersSent) {
                    res.status(503).send({ code: "PAIR_FAIL", error: err.message });
                }
                rm(dir);
                sock.end();
            }
        }
    }

    start();
});

process.on("uncaughtException", (err) => {
    const e = String(err);
    if (e.includes("conflict") || e.includes("not-authorized") || e.includes("Timed Out")) return;
    console.error("Crash:", err);
});

process.on("unhandledRejection", (err) => {
    console.error("Unhandled Rejection:", err);
});

export default router;
