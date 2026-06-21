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
import QRCode from "qrcode";
import { upload } from "./mega.js";

const router = express.Router();

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

function getMegaFileId(url) {
    try {
        const match = url.match(/\/file\/([^#]+#[^\/]+)/);
        return match ? match[1] : null;
    } catch (error) {
        return null;
    }
}

router.get("/", async (req, res) => {
    const sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const dirs = `./qr_sessions/session_${sessionId}`;

    if (!fs.existsSync("./qr_sessions")) {
        fs.mkdirSync("./qr_sessions", { recursive: true });
    }

    await removeFile(dirs);

    let responseSent = false;
    let sock = null;

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version } = await fetchLatestBaileysVersion();

            sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.windows("Chrome"),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
            });

            sock.ev.on("creds.update", saveCreds);

            sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, isNewLogin, isOnline, qr } = update;

                if (qr && !responseSent) {
                    console.log("🟢 QR Code Generated! Scan it with your WhatsApp app.");
                    try {
                        const qrDataURL = await QRCode.toDataURL(qr, {
                            errorCorrectionLevel: "M",
                            type: "image/png",
                            quality: 0.92,
                            margin: 1,
                            color: { dark: "#000000", light: "#FFFFFF" },
                        });

                        if (!responseSent) {
                            responseSent = true;
                            console.log("QR Code sent to client");
                            res.send({
                                qr: qrDataURL,
                                message: "QR Code Generated! Scan it with your WhatsApp app.",
                                instructions: [
                                    "1. Open WhatsApp on your phone",
                                    "2. Go to Settings > Linked Devices",
                                    '3. Tap "Link a Device"',
                                    "4. Scan the QR code above",
                                ],
                            });
                        }
                    } catch (qrError) {
                        console.error("Error generating QR code:", qrError);
                        if (!responseSent) {
                            responseSent = true;
                            res.status(500).send({ code: "Failed to generate QR code" });
                        }
                    }
                }

                if (connection === "open") {
                    console.log("✅ Connected successfully!");
                    console.log("📱 Uploading session to MEGA...");
                    try {
                        const credsPath = dirs + "/creds.json";
                        const megaUrl = await upload(credsPath, `creds_qr_${sessionId}.json`);
                        const megaFileId = getMegaFileId(megaUrl);

                        if (megaFileId) {
                            console.log("✅ Session uploaded to MEGA. File ID:", megaFileId);
                            const userJid = jidNormalizedUser(sock.authState.creds.me?.id || "");
                            if (userJid) {
                                await sock.sendMessage(userJid, { text: `${megaFileId}` });
                                console.log("📄 MEGA file ID sent successfully");
                            } else {
                                console.log("❌ Could not determine user JID");
                            }
                        } else {
                            console.log("❌ Failed to upload to MEGA");
                        }
                    } catch (error) {
                        console.error("❌ Error uploading to MEGA (ignored):", error);
                        // ✅ We don't exit; just log the error and continue.
                    }

                    console.log("🧹 Cleaning up session...");
                    await delay(1000);
                    removeFile(dirs);
                    console.log("✅ Session cleaned up successfully");
                    console.log("🎉 Process completed for this QR request.");
                    // ✅ No process.exit — just let the function finish.
                }

                if (isNewLogin) {
                    console.log("🔐 New login via QR code");
                }

                if (isOnline) {
                    console.log("📶 Client is online");
                }

                if (connection === "close") {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    if (statusCode === 401) {
                        console.log("❌ Logged out from WhatsApp. Need to generate new QR code.");
                    } else {
                        console.log("🔁 Connection closed — cleaning up.");
                        // ✅ Instead of restarting, just clean up and finish.
                        removeFile(dirs);
                    }
                }
            });

            // Timeout after 30 seconds if QR not sent
            setTimeout(() => {
                if (!responseSent) {
                    responseSent = true;
                    res.status(408).send({ code: "QR generation timeout" });
                    removeFile(dirs);
                    if (sock) sock.end();
                }
            }, 30000);

        } catch (err) {
            console.error("Error initializing session:", err);
            if (!res.headersSent) {
                res.status(503).send({ code: "Service Unavailable" });
            }
            removeFile(dirs);
            if (sock) sock.end();
        }
    }

    await initiateSession();
});

process.on("uncaughtException", (err) => {
    let e = String(err);
    if (e.includes("conflict") || e.includes("not-authorized") || e.includes("Socket connection timeout") ||
        e.includes("rate-overlimit") || e.includes("Connection Closed") || e.includes("Timed Out") ||
        e.includes("Value not found") || e.includes("Stream Errored") || e.includes("statusCode: 515") ||
        e.includes("statusCode: 503")) {
        return;
    }
    console.log("Caught exception: ", err);
});

process.on("unhandledRejection", (err) => {
    console.error("Unhandled Rejection:", err);
});

export default router;
