
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

const PANEL_WIDTH = 32;

function wrapLine(value, width = PANEL_WIDTH) {
  const words = String(value ?? "").split(/\s+/).filter(Boolean);
  const output = [];
  let line = "";

  for (const word of words) {
    const chars = Array.from(word);

    if (chars.length > width) {
      if (line) {
        output.push(line);
        line = "";
      }

      while (chars.length > width) {
        output.push(chars.splice(0, width).join(""));
      }

      if (chars.length) line = chars.join("");
      continue;
    }

    const candidate = line ? line + " " + word : word;

    if (Array.from(candidate).length > width) {
      if (line) output.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }

  if (line) output.push(line);
  return output.length ? output : [""];
}

function makePanel(title, lines = []) {
  const heading = wrapLine(title)[0] || "SCANTY MD BOT";
  const body = lines.flatMap(line => wrapLine(line));
  const border = "━".repeat(PANEL_WIDTH + 2);

  const row = line =>
    "┃ " + line.padEnd(PANEL_WIDTH, " ") + " ┃";

  return [
    "╭" + border + "╮",
    row(heading),
    "┣" + border + "┫",
    ...body.map(row),
    "╰" + border + "╯"
  ].join("\n");
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

    // Allow commands sent from the connected account to its own chat.
    if (key?.fromMe) {
      const normalizeJid = value =>
        String(value || "")
          .trim()
          .toLowerCase()
          .replace(/:\d+(?=@)/, "");

      const ownJids = [
        sock.user?.id,
        sock.user?.lid
      ]
        .filter(Boolean)
        .map(normalizeJid);

      const remoteJids = [
        key.remoteJid,
        key.remoteJidAlt
      ]
        .filter(Boolean)
        .map(normalizeJid);

      const isOwnChat = remoteJids.some(remote =>
        ownJids.includes(remote)
      );

      if (!isOwnChat) {
        await log("info", "SELF-CHAT MESSAGE FILTERED", {
          sessionId,
          remoteJid: key.remoteJid || null,
          remoteJidAlt: key.remoteJidAlt || null,
          ownId: sock.user?.id || null,
          ownLid: sock.user?.lid || null
        });

        return;
      }
    }

    const text = extractText(message?.message).trim();

    await log("info", "MESSAGE HANDLER EXTRACTED TEXT", {
      sessionId,
      remoteJid: jid,
      textLength: text.length,
      startsWithCommandPrefix: text.startsWith(".")
    });

    if (!text.startsWith(".")) return;

    const [rawCommand, ...args] =
      text.slice(1).trim().split(/\s+/);

    const command = String(rawCommand || "").toLowerCase();
    const argument = String(args[0] || "").toLowerCase();

    if (!command) return;

    const reply = value => sendText(sock, jid, value);

    const panelReply = (title, lines) =>
      reply(makePanel(title, lines));

    await log("info", "MESSAGE COMMAND DISPATCH", {
      sessionId,
      remoteJid: jid,
      command
    });

    try {
      if (
        command === "autoviewstatus" ||
        command === "statusreact"
      ) {
        const field =
          command === "autoviewstatus"
            ? "autoViewStatus"
            : "statusReact";

        if (!["on", "off"].includes(argument)) {
          const config = await getSettings(sessionId);

          return await panelReply("SETTINGS", [
            `Command: .${command} on/off`,
            `Current: ${config[field] ? "ON" : "OFF"}`
          ]);
        }

        await updateSettings(sessionId, {
          [field]: argument === "on"
        });

        return await panelReply("SETTING UPDATED", [
          `✓ ${command} is now ${argument.toUpperCase()}.`
        ]);
      }

      switch (command) {
        case "menu":
        case "help":
          return await panelReply("SCANTY MD BOT | MENU", [
            "GENERAL COMMANDS",
            ".menu  - Show this menu",
            ".help  - Show this menu",
            ".ping  - Check response speed",
            ".alive - Check bot connection",
            ".status - Show bot status",
            ".uptime - Show running time",
            "STATUS SETTINGS",
            ".autoviewstatus on/off",
            ".statusreact on/off",
            "Tip: Send a command in this chat."
          ]);

        case "ping": {
          const started = Date.now();

          await panelReply("PING", [
            "🏓 PONG!"
          ]);

          await log("info", "PING COMMAND REPLIED", {
            sessionId,
            remoteJid: jid,
            elapsedMs: Date.now() - started
          });

          return;
        }

        case "alive":
          return await panelReply("BOT STATUS", [
            "✓ SCANTY MD BOT is online.",
            "Your WhatsApp session is connected."
          ]);

        case "status": {
          const row = await sessions.findOne(
            { sessionId },
            { projection: { status: 1, phone: 1 } }
          );

          const cfg = await getSettings(sessionId);

          return await panelReply("BOT STATUS", [
            `Connection: ${row?.status || "unknown"}`,
            `Phone: ${row?.phone || "unknown"}`,
            `Auto view status: ${cfg.autoViewStatus ? "ON" : "OFF"}`,
            `Status react: ${cfg.statusReact ? "ON" : "OFF"}`
          ]);
        }

        case "uptime": {
          const total = Math.floor(process.uptime());
          const h = Math.floor(total / 3600);
          const m = Math.floor((total % 3600) / 60);
          const s = total % 60;

          return await panelReply("BOT UPTIME", [
            `Running: ${h}h ${m}m ${s}s`
          ]);
        }

        default:
          return await panelReply("UNKNOWN COMMAND", [
            `Command: .${command}`,
            "Send .menu to see available commands."
          ]);
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
        await panelReply("COMMAND ERROR", [
          "The command could not be completed.",
          "Please try again."
        ]);
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
