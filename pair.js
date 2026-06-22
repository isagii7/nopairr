import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { 
    makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    makeCacheableSignalKeyStore, 
    Browsers, 
    jidNormalizedUser, 
    fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';

const router = express.Router();

// ===== Generate session string from creds =====
function getSessionString(creds) {
    try {
        const base64Creds = Buffer.from(JSON.stringify(creds)).toString('base64');
        return `NEXTY-MD~${base64Creds}`;
    } catch (error) {
        console.error("Error encoding creds:", error);
        return null;
    }
}

// ===== Safe directory removal =====
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
        return true;
    } catch (e) {
        console.error('Cleanup error:', e);
        return false;
    }
}

router.get('/', async (req, res) => {
    let num = (req.query.number || "").replace(/[^0-9]/g, "");
    if (!num) {
        return res.status(400).send({ code: 'Phone number is required' });
    }

    const phone = pn('+' + num);
    if (!phone.isValid()) {
        return res.status(400).send({ 
            code: 'Invalid phone number. Please enter your full international number (e.g., 15551234567 for US, 447911123456 for UK) without + or spaces.' 
        });
    }
    num = phone.getNumber('e164').replace('+', '');

    // Use a fixed session folder (you can change it)
    const dirs = './NEXTY-MD~';

    // Remove any leftover session
    await removeFile(dirs);

    let sessionSent = false;
    let sock;
    let timeoutId;

    // ===== Send session string and branded messages =====
    async function sendSessionNow() {
        if (sessionSent) return;
        sessionSent = true;
        console.log("📤 Sending session string...");

        try {
            const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
            const sessionString = getSessionString(sock.authState.creds);
            if (!sessionString) throw new Error("Failed to encode creds");

            // 1️⃣ Send session string as plain text
            await sock.sendMessage(userJid, { text: sessionString });
            console.log("✅ Session string sent");

            // 2️⃣ Send branded info (image + caption)
            await delay(1000);

            // Fake vCard for quoting (branding)
            const fakeVCardQuoted = {
                key: {
                    fromMe: false,
                    participant: "0@s.whatsapp.net",
                    remoteJid: "status@broadcast"
                },
                message: {
                    contactMessage: {
                        displayName: "© NEXXTY XMD",
                        vcard: `BEGIN:VCARD
VERSION:3.0
FN:© NEXXTY XMD
ORG:NEXXTY XMD;
TEL;type=CELL;type=VOICE;waid=13135550002:+13135550002
END:VCARD`
                    }
                }
            };

            const caption = `
╭─［ *ᴘᴏᴡᴇʀᴇᴅ ʙʏ ɴᴇxᴛʏ-ᴍᴅ* ］─··╮
│★╭─────────────────────╮
│★│ 👑 Owner : *NEXXTY XMD*
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
                userJid,
                {
                    image: { url: "https://files.catbox.moe/93fe56.jpg" }, // Replace with your own image
                    caption,
                    contextInfo: {
                        mentionedJid: [userJid],
                        forwardingScore: 999,
                        isForwarded: true,
                        forwardedNewsletterMessageInfo: {
                            newsletterJid: "116505769414861@lid",
                            newsletterName: "NEXXTY XMD",
                            serverMessageId: 143
                        }
                    }
                },
                { quoted: fakeVCardQuoted }
            );
            console.log("✅ Branded info sent");

            // 3️⃣ Send a final warning (optional)
            await sock.sendMessage(userJid, {
                text: `⚠️ Do not share this session string with anybody.\n\nThanks for using NEXXTY XMD!`
            });

            // Cleanup after a short delay
            await delay(1000);
            removeFile(dirs);
            console.log("🧹 Session cleaned up");
            sock.end();
        } catch (err) {
            console.error("❌ Error sending session:", err);
            removeFile(dirs);
            sock.end();
        }
    }

    // ===== Main session initialisation =====
    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            logger: pino({ level: "fatal" }).child({ level: "fatal" }),
            browser: Browsers.windows('Chrome'),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 250,
            maxRetries: 5,
        });

        sock.ev.on('creds.update', saveCreds);

        // ===== Connection events =====
        sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
            console.log(`🔄 Connection update: ${connection}`);

            if (connection === 'open' && !sessionSent) {
                console.log("✅ Connection open! Sending session...");
                if (timeoutId) clearTimeout(timeoutId);
                await sendSessionNow();
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === 401) {
                    console.log("❌ Unauthorised — pairing failed");
                } else {
                    console.log("🔁 Connection closed — cleaning up");
                }
                if (!sessionSent) {
                    removeFile(dirs);
                    sock.end();
                }
            }
        });

        // ===== Request pairing code =====
        if (!sock.authState.creds.registered) {
            await delay(3000);
            try {
                let code = await sock.requestPairingCode(num);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                if (!res.headersSent) {
                    res.send({ 
                        success: true, 
                        code: code,
                        message: "Enter this code in WhatsApp Web to connect" 
                    });
                }
                console.log(`✅ Pairing code sent: ${code}`);

                // Timeout: if no open connection within 40s, clean up
                timeoutId = setTimeout(() => {
                    if (!sessionSent) {
                        console.log("⏰ Timeout: No connection open. Cleaning up.");
                        removeFile(dirs);
                        sock.end();
                    }
                }, 40000);
            } catch (err) {
                console.error("Pairing error:", err);
                if (!res.headersSent) {
                    res.status(503).send({ code: 'PAIR_FAIL', error: err.message });
                }
                removeFile(dirs);
                sock.end();
            }
        }
    }

    await initiateSession();
});

// Global exception handlers (ignore non-critical errors)
process.on('uncaughtException', (err) => {
    const e = String(err);
    if (e.includes("conflict") || e.includes("not-authorized") || e.includes("Timed Out")) return;
    console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});

export default router;
