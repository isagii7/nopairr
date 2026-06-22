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
import QRCode from 'qrcode';

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
    // Use a fixed session folder for QR (separate from pair to avoid conflicts)
    const dirs = './qr_sessions/NEXTY-MD-QR~';

    // Ensure base folder exists
    if (!fs.existsSync('./qr_sessions')) {
        fs.mkdirSync('./qr_sessions', { recursive: true });
    }

    // Remove any leftover session
    await removeFile(dirs);

    let sessionSent = false;
    let sock;
    let timeoutId;
    let responseSent = false; // To avoid sending QR twice

    // ===== Send session string and branded messages =====
    async function sendSessionNow(userJid) {
        if (sessionSent) return;
        sessionSent = true;
        console.log("📤 Sending session string to user...");

        try {
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

    // ===== Start session =====
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
        sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
            console.log(`🔄 Connection update: ${connection || 'qr'}`);

            // Handle QR code generation
            if (qr && !responseSent) {
                responseSent = true;
                console.log("🟢 QR Code generated");
                try {
                    const qrDataURL = await QRCode.toDataURL(qr, {
                        errorCorrectionLevel: 'M',
                        type: 'image/png',
                        quality: 0.92,
                        margin: 1,
                        color: { dark: '#000000', light: '#FFFFFF' }
                    });
                    // Send QR to the web client
                    await res.send({
                        qr: qrDataURL,
                        message: 'QR Code Generated! Scan it with your WhatsApp app.',
                        instructions: [
                            '1. Open WhatsApp on your phone',
                            '2. Go to Settings > Linked Devices',
                            '3. Tap "Link a Device"',
                            '4. Scan the QR code above'
                        ]
                    });
                } catch (qrErr) {
                    console.error('QR generation error:', qrErr);
                    if (!res.headersSent) {
                        res.status(500).send({ code: 'QR generation failed' });
                    }
                }
            }

            if (connection === 'open' && !sessionSent) {
                console.log("✅ Connection open! Sending session...");
                if (timeoutId) clearTimeout(timeoutId);
                // Get user JID from creds
                const userJid = Object.keys(sock.authState.creds.me || {}).length > 0
                    ? jidNormalizedUser(sock.authState.creds.me.id)
                    : null;
                if (userJid) {
                    await sendSessionNow(userJid);
                } else {
                    console.log("❌ Could not determine user JID");
                    removeFile(dirs);
                    sock.end();
                }
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

        // ===== QR mode doesn't request a pairing code, so we rely on QR scanning =====
        // Set a timeout if QR is never generated or connection never opens
        timeoutId = setTimeout(() => {
            if (!responseSent) {
                console.log("⏰ Timeout: No QR generated. Cleaning up.");
                if (!res.headersSent) {
                    res.status(408).send({ code: 'QR generation timeout' });
                }
                removeFile(dirs);
                sock.end();
            }
        }, 30000); // 30 seconds for QR generation
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
