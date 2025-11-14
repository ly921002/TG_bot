export default {
  async fetch(request, env) {
    const TELEGRAM_API = `https://api.telegram.org/bot${env.BOT_TOKEN}`;
    const DEFAULT_LANG = "en";

    // 多管理员支持
    const ADMIN_IDS = (env.ADMIN_IDS || env.ADMIN_ID || "")
      .split(",")
      .map(id => id.trim())
      .filter(Boolean);

    // 欢迎语
    const WELCOME_MESSAGES = {
      en: "👋 Welcome! Send me a message and I'll forward it to the admin.",
      zh: "👋 欢迎！请发送消息，我会帮你转发给管理员。",
    };

    const url = new URL(request.url);
    let LAST_UPDATE = null;

    // 反垃圾临时记录（worker 内存）
    const RATE_LIMITS = new Map();
    const RATE_INTERVAL = 5000; // 5秒限频

    // ====== 可调试接口 /debug ======
    if (request.method === "GET" && url.pathname === "/debug") {
      return new Response(
        LAST_UPDATE ? JSON.stringify(LAST_UPDATE, null, 2) : "No updates",
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // ====== 设置 Webhook ======
    if (request.method === "GET" && url.pathname === "/setWebhook") {
      const webhookUrl = `https://${url.host}/`;
      const res = await fetch(`${TELEGRAM_API}/setWebhook?url=${webhookUrl}`);
      return new Response(await res.text(), { headers: { "Content-Type": "application/json" } });
    }

    // ====== Telegram Webhook 主处理 ======
    if (request.method === "POST") {
      const update = await request.json();
      LAST_UPDATE = update;

      console.log("📩 Incoming update:", JSON.stringify(update));

      // ====== 按钮回调（验证人类身份） ======
      if (update.callback_query) {
        const cq = update.callback_query;
        const userId = cq.from.id;

        if (cq.data === "verify_human") {
          // 存储人类验证状态
          await env.LIVEGRAM_KV.put(`verify_${userId}`, "true");

          // 回答 callback
          await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              callback_query_id: cq.id,
              text: "验证成功！你现在可以发送消息了 👌"
            }),
          });

          await sendMessage(userId, "🎉 验证完成！请继续发送你的消息。");
        }

        return new Response("callback OK");
      }

      if (!update.message) return new Response("No message");
      const msg = update.message;

      const chatId = msg.chat.id;
      const text = msg.text || "";
      const from = msg.from;
      const isPrivate = msg.chat.type === "private";
      const isReply = !!msg.reply_to_message;
      const now = Date.now();

      // ================================
      // 🛡️ 反垃圾限制：5秒内禁止重复发送
      // ================================
      if (isPrivate) {
        const last = RATE_LIMITS.get(from.id) || 0;
        if (now - last < RATE_INTERVAL) {
          await sendMessage(chatId, "⚠️ 发送太频繁，请稍候再试。");
          return new Response("Rate limited");
        }
        RATE_LIMITS.set(from.id, now);
      }

      // ================================
      // 🔐 检查用户是否已通过验证
      // ================================
      if (isPrivate) {
        const verified = await env.LIVEGRAM_KV.get(`verify_${from.id}`);

        if (!verified) {
          await sendVerifyButton(chatId);
          return new Response("Waiting for verify");
        }
      }

      // ================================
      // 👋 /start 命令
      // ================================
      if (isPrivate && text.startsWith("/start")) {
        const lang = from.language_code?.startsWith("zh") ? "zh" : DEFAULT_LANG;
        await sendMessage(chatId, WELCOME_MESSAGES[lang]);
        return new Response("Welcome sent");
      }

      // ================================
      // 👥 群组管理员回复用户
      // ================================
      if (!isPrivate && isReply) {
        const replyText = msg.reply_to_message.text;
        const match = replyText.match(/id:(\d+)/);

        if (match) {
          const targetId = match[1];
          await sendMessage(targetId, `💬 Admin replied:\n${text}`);
          return new Response("Reply OK");
        }
      }

      // ================================
      // ✉️ 用户发来私聊 → 转发给管理员
      // ================================
      if (isPrivate && !text.startsWith("/")) {
        const tag = `👤 From: @${from.username || from.first_name} (id:${from.id})`;

        // 保存用户上下文
        await env.LIVEGRAM_KV.put(
          `context_${from.id}`,
          JSON.stringify({ last_message: text, time: now })
        );

        for (const adminId of ADMIN_IDS) {
          await forwardMessage(chatId, msg.message_id, adminId);
          await sendMessage(adminId, tag);
        }

        return new Response("Forwarded");
      }

      return new Response("OK");
    }

    return new Response("Livegram Worker running");

    // ===== 工具函数 =====
    async function sendMessage(chat_id, text) {
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id, text }),
      });
    }

    async function forwardMessage(fromChatId, messageId, adminId) {
      await fetch(`${TELEGRAM_API}/forwardMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: adminId,
          from_chat_id: fromChatId,
          message_id: messageId
        }),
      });
    }

    async function sendVerifyButton(chat_id) {
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id,
          text: "🤖 为了安全，请点击下面的按钮验证你是真人。",
          reply_markup: {
            inline_keyboard: [
              [{ text: "I'm not a bot ✅", callback_data: "verify_human" }]
            ]
          }
        }),
      });
    }
  }
};
