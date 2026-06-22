import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';

const router = express.Router();

// ===== محفوظ طریقے سے فولڈر ہٹائیں =====
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

    // ===== منفرد سیشن فولڈر =====
    const sessionId = `session_${num}_${Date.now()}`;
    const dirs = `./sessions/${sessionId}`;

    // پہلے سے موجود کو صاف کریں (اگر کوئی بچا ہوا ہو)
    if (fs.existsSync(dirs)) await removeFile(dirs);
    fs.mkdirSync(dirs, { recursive: true });

    let sessionSent = false;
    let sock;
    let timeoutId;
    let responseSent = false;

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version, isLatest } = await fetchLatestBaileysVersion();
            sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.windows('Chrome'),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
            });

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, isNewLogin, isOnline } = update;

                if (connection === 'open' && !sessionSent) {
                    sessionSent = true;
                    console.log("✅ Connected successfully!");
                    console.log("📱 Sending session file to user...");
                    
                    try {
                        const sessionKnight = fs.readFileSync(dirs + '/creds.json');

                        const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                        await sock.sendMessage(userJid, {
                            document: sessionKnight,
                            mimetype: 'application/json',
                            fileName: 'creds.json'
                        });
                        console.log("📄 Session file sent successfully");

                        await sock.sendMessage(userJid, {
                            image: { url: 'https://img.youtube.com/vi/-oz_u1iMgf8/maxresdefault.jpg' },
                            caption: `🎬 *KnightBot MD V2.0 Full Setup Guide!*\n\n🚀 Bug Fixes + New Commands + Fast AI Chat\n📺 Watch Now: https://youtu.be/NjOipI2AoMk`
                        });
                        console.log("🎬 Video guide sent successfully");

                        await sock.sendMessage(userJid, {
                            text: `⚠️Do not share this file with anybody⚠️\n 
┌┤✑  Thanks for using Knight Bot
│└────────────┈ ⳹        
│©2025 Mr Unique Hacker 
└─────────────────┈ ⳹\n\n`
                        });
                        console.log("⚠️ Warning message sent successfully");

                        console.log("🧹 Cleaning up session...");
                        await delay(1000);
                        removeFile(dirs);
                        console.log("✅ Session cleaned up successfully");
                        console.log("🎉 Process completed successfully!");
                        sock.end();
                    } catch (error) {
                        console.error("❌ Error sending messages:", error);
                        removeFile(dirs);
                        sock.end();
                    }
                }

                if (isNewLogin) {
                    console.log("🔐 New login via pair code");
                }

                if (isOnline) {
                    console.log("📶 Client is online");
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    console.log(`❌ Connection closed, statusCode: ${statusCode}`);
                    if (statusCode === 401) {
                        console.log("❌ Logged out from WhatsApp. Need to generate new pair code.");
                    } else {
                        console.log("🔁 Connection closed — will retry...");
                        // Retry only if session not sent yet
                        if (!sessionSent && !responseSent) {
                            // Cleanup old folder and restart
                            removeFile(dirs);
                            // Restart session
                            initiateSession();
                        }
                    }
                }
            });

            if (!sock.authState.creds.registered) {
                await delay(3000);
                num = num.replace(/[^\d+]/g, '');
                if (num.startsWith('+')) num = num.substring(1);

                try {
                    let code = await sock.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    if (!res.headersSent) {
                        console.log({ num, code });
                        await res.send({ code });
                        responseSent = true;
                    }
                } catch (error) {
                    console.error('Error requesting pairing code:', error);
                    if (!res.headersSent) {
                        res.status(503).send({ code: 'Failed to get pairing code. Please check your phone number and try again.' });
                        responseSent = true;
                    }
                    removeFile(dirs);
                    sock.end();
                }
            }

            // ===== ٹائم آؤٹ (60 سیکنڈ) =====
            timeoutId = setTimeout(() => {
                if (!sessionSent) {
                    console.log("⏰ Timeout: No connection open after 60s. Cleaning up.");
                    removeFile(dirs);
                    sock.end();
                    if (!responseSent) {
                        res.status(408).send({ code: 'TIMEOUT' });
                        responseSent = true;
                    }
                }
            }, 60000);

        } catch (err) {
            console.error('Error initializing session:', err);
            if (!res.headersSent) {
                res.status(503).send({ code: 'Service Unavailable' });
                responseSent = true;
            }
            removeFile(dirs);
        }
    }

    await initiateSession();
});

// ===== گلوبل ایرر ہینڈلر (اصل کوڈ کے مطابق) =====
process.on('uncaughtException', (err) => {
    let e = String(err);
    if (e.includes("conflict")) return;
    if (e.includes("not-authorized")) return;
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("rate-overlimit")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Timed Out")) return;
    if (e.includes("Value not found")) return;
    if (e.includes("Stream Errored")) return;
    if (e.includes("Stream Errored (restart required)")) return;
    if (e.includes("statusCode: 515")) return;
    if (e.includes("statusCode: 503")) return;
    console.log('Caught exception: ', err);
});

export default router;
