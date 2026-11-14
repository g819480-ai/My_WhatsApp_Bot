function extractText(message) {
  let msg = message || {};

  for (let i = 0; i < 8; i++) {
    const nested =
      msg.ephemeralMessage?.message ||
      msg.viewOnceMessage?.message ||
      msg.viewOnceMessageV2?.message ||
      msg.viewOnceMessageV2Extension?.message ||
      msg.documentWithCaptionMessage?.message ||
      msg.editedMessage?.message;

    if (!nested) break;
    msg = nested;
  }

  const value =
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    msg.documentMessage?.caption ??
    msg.buttonsResponseMessage?.selectedButtonId ??
    msg.listResponseMessage?.singleSelectReply?.selectedRowId ??
    msg.templateButtonReplyMessage?.selectedId ??
    "";

  return typeof value === "string" ? value : "";
}

export function createMessageHandler({
  sessions,
  getSettings,
  updateSettings,
  sendText,
  log
}) {
  return async function handleIncoming(sessionId, sock, message) {
    const key = message?.key;
    const jid = key?.remoteJid;

    await log("info", "MESSAGE HANDLER RECEIVED MESSAGE", {
      sessionId,
      remoteJid: jid || null,
      fromMe: Boolean(key?.fromMe),
      messageId: key?.id || null,
      messageTypes: Object.keys(message?.message || {})
    });

    if (!jid || jid === "status@broadcast") return;

    // Allow messages sent from this account to its own chat.
    if (key?.fromMe) {
      const ownId = sock.user?.id
        ? sock.user.id.split(":")[0].split("@")[0]
        : null;

      const ownJid = ownId
        ? ownId + "@s.whatsapp.net"
        : null;

      const ownLid = sock.user?.lid || null;

      if (jid !== ownJid && jid !== ownLid) return;
    }

    const text = extractText(message?.message).trim();

    await log("info", "MESSAGE HANDLER EXTRACTED TEXT", {
      sessionId,
      remoteJid: jid,
      textLength: text.length,
      startsWithCommandPrefix: text.startsWith(".")
    });

    if (!text.startsWith(".")) return;

    const [rawCommand, ...args] = text.slice(1).trim().split(/\s+/);
    const command = String(rawCommand || "").toLowerCase();
    const argument = String(args[0] || "").toLowerCase();

    if (!command) return;

    const reply = value => sendText(sock, jid, value);

    await log("info", "MESSAGE COMMAND DISPATCH", {
      sessionId,
      remoteJid: jid,
      command
    });

    try {
      if (command === "autoviewstatus" || command === "statusreact") {
        const field =
          command === "autoviewstatus"
            ? "autoViewStatus"
            : "statusReact";

        if (!["on", "off"].includes(argument)) {
          const config = await getSettings(sessionId);

          return await reply(
            `Usage: .${command} on/off\nCurrent: ${
              config[field] ? "ON" : "OFF"
            }`
          );
        }

        await updateSettings(sessionId, {
          [field]: argument === "on"
        });

        return await reply(
          `✅ ${command} is now ${argument.toUpperCase()}.`
        );
      }

      switch (command) {
        case "menu":
        case "help":
          return await reply(
            "╭━━━〔 SCANTY MD BOT 〕━━━╮\n" +
            "┃ .menu — Show commands\n" +
            "┃ .help — Show commands\n" +
            "┃ .ping — Check response speed\n" +
            "┃ .alive — Check bot connection\n" +
            "┃ .status — Show bot status\n" +
            "┃ .uptime — Show running time\n" +
            "┃ .autoviewstatus on/off\n" +
            "┃ .statusreact on/off\n" +
            "╰━━━━━━━━━━━━━━━━━━━━╯"
          );

        case "ping": {
          const started = Date.now();
          await reply("🏓 Pong!");
          await log("info", "PING COMMAND REPLIED", {
            sessionId,
            remoteJid: jid,
            elapsedMs: Date.now() - started
          });
          return;
        }

        case "alive":
          return await reply(
            "✅ SCANTY MD BOT is online and connected."
          );

        case "status": {
          const row = await sessions.findOne(
            { sessionId },
            { projection: { status: 1, phone: 1 } }
          );

          const cfg = await getSettings(sessionId);

          return await reply(
            `🤖 SCANTY MD BOT\n` +
            `Status: ${row?.status || "unknown"}\n` +
            `Phone: ${row?.phone || "unknown"}\n` +
            `Auto view status: ${cfg.autoViewStatus ? "ON" : "OFF"}\n` +
            `Status react: ${cfg.statusReact ? "ON" : "OFF"}`
          );
        }

        case "uptime": {
          const total = Math.floor(process.uptime());
          const h = Math.floor(total / 3600);
          const m = Math.floor((total % 3600) / 60);
          const s = total % 60;

          return await reply(
            `⏱️ Uptime: ${h}h ${m}m ${s}s`
          );
        }

        default:
          return await reply(
            `❓ Unknown command: .${command}\n` +
            "Send .menu to see available commands."
          );
      }
    } catch (error) {
      await log("error", "Incoming command failed", {
        sessionId,
        remoteJid: jid,
        command,
        error: error?.message || String(error),
        stack: error?.stack
      });

      try {
        await reply("❌ Command failed. Please try again.");
      } catch (sendError) {
        await log("error", "Command error reply could not be sent", {
          sessionId,
          command,
          error: sendError?.message || String(sendError)
        });
      }
    }
  };
}
