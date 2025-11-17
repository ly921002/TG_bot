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
      en: "👋👋 Welcome! Send me a message and I'll forward it to the admin.",
      zh: "👋👋 欢迎！请发送消息，我会帮你转发给管理员。",
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

      console.log("📩📩 Incoming update:", JSON.stringify(update));

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
              text: "验证成功！你现在可以发送消息了 👌👌"
            }),
          });

          await sendMessage(userId, "🎉🎉 验证完成！请继续发送你的消息。");
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
      // 🛡🛡🛡️ 反垃圾限制：5秒内禁止重复发送
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
      // 🔐🔐 检查用户是否已通过验证
      // ================================
      if (isPrivate) {
        const verified = await env.LIVEGRAM_KV.get(`verify_${from.id}`);

        if (!verified) {
          await sendVerifyButton(chatId);
          return new Response("Waiting for verify");
        }
      }

      // ================================
      // 👋👋 /start 命令
      // ================================
      if (isPrivate && text.startsWith("/start")) {
        const lang = from.language_code?.startsWith("zh") ? "zh" : DEFAULT_LANG;
        await sendMessage(chatId, WELCOME_MESSAGES[lang]);
        return new Response("Welcome sent");
      }

      // ================================
      // 👥👥 群组管理员回复用户（支持多种消息类型）
      // ================================
      if (!isPrivate && isReply) {
        try {
          const replyMsg = msg.reply_to_message;
          
          // 从回复消息的文本或转发信息中提取用户ID
          let targetId = null;
          
          // 方法1: 从消息文本中匹配 (适用于文本消息)
          if (replyMsg.text) {
            const match = replyMsg.text.match(/id:(\d+)/);
            if (match) {
              targetId = match[1];
            }
          }
          
          // 方法2: 从caption中匹配 (适用于带标题的媒体消息)
          if (!targetId && replyMsg.caption) {
            const match = replyMsg.caption.match(/id:(\d+)/);
            if (match) {
              targetId = match[1];
            }
          }
          
          // 方法3: 从转发信息中提取 (适用于媒体消息)
          if (!targetId && replyMsg.forward_origin) {
            // 从转发信息中获取原始发送者ID
            if (replyMsg.forward_origin.sender_user) {
              targetId = replyMsg.forward_origin.sender_user.id.toString();
            }
            // 如果是隐藏用户转发，尝试从其他字段提取
            else if (replyMsg.forward_origin.sender_user_name) {
              // 这里可以根据用户名查找对应的用户ID，需要额外处理
              console.log("Hidden user forward, username:", replyMsg.forward_origin.sender_user_name);
            }
          }

          if (targetId) {
            // 根据消息类型发送相应的回复
            let success = false;
            
            if (msg.text) {
              // 文本消息
              await sendMessage(targetId, `💬💬 Admin replied:\n${msg.text}`);
              success = true;
            } else if (msg.photo) {
              // 照片消息
              const photoId = msg.photo[msg.photo.length - 1].file_id;
              const caption = msg.caption ? `💬💬 Admin replied:\n${msg.caption}` : "💬💬 Admin replied with a photo";
              await sendPhoto(targetId, photoId, caption);
              success = true;
            } else if (msg.video) {
              // 视频消息
              const videoId = msg.video.file_id;
              const caption = msg.caption ? `💬💬 Admin replied:\n${msg.caption}` : "💬💬 Admin replied with a video";
              await sendVideo(targetId, videoId, caption);
              success = true;
            } else if (msg.document) {
              // 文档消息
              const documentId = msg.document.file_id;
              const caption = msg.caption ? `💬💬 Admin replied:\n${msg.caption}` : "💬💬 Admin replied with a document";
              await sendDocument(targetId, documentId, caption);
              success = true;
            } else if (msg.audio) {
              // 音频消息
              const audioId = msg.audio.file_id;
              const caption = msg.caption ? `💬💬 Admin replied:\n${msg.caption}` : "💬💬 Admin replied with an audio";
              await sendAudio(targetId, audioId, caption);
              success = true;
            } else if (msg.voice) {
              // 语音消息
              const voiceId = msg.voice.file_id;
              await sendVoice(targetId, voiceId);
              success = true;
            } else if (msg.sticker) {
              // 贴纸消息
              const stickerId = msg.sticker.file_id;
              await sendSticker(targetId, stickerId);
              success = true;
            } else {
              // 不支持的消息类型
              await sendMessage(chatId, "❌ Unsupported message type for reply.");
              return new Response("Unsupported message type");
            }
            
            if (success) {
              await sendMessage(chatId, "✅ Reply sent successfully!");
              return new Response("Reply OK");
            }
          } else {
            // 如果无法提取用户ID，给管理员提示
            await sendMessage(chatId, "⚠️ Cannot extract user ID from the replied message. Please make sure you're replying to a forwarded user message.");
            return new Response("Cannot extract user ID");
          }
        } catch (error) {
          console.error("Error handling reply:", error);
          await sendMessage(chatId, "❌ Error processing your reply.");
          return new Response("Error handling reply");
        }
      }

      // ================================
      // ✉✉️ 用户发来私聊 → 转发给管理员
      // ================================
      if (isPrivate && !text.startsWith("/")) {
        const tag = `👤👤 From: @${from.username || from.first_name} (id:${from.id})`;

        // 保存用户上下文
        await env.LIVEGRAM_KV.put(
          `context_${from.id}`,
          JSON.stringify({ last_message: text, time: now })
        );

        for (const adminId of ADMIN_IDS) {
          // 先转发原始消息
          await forwardMessage(chatId, msg.message_id, adminId);
          // 再发送用户信息标签
          await sendMessage(adminId, tag);
        }

        // 给用户发送确认消息
        await sendMessage(chatId, "✅ Message sent to admin!");
        return new Response("Forwarded");
      }

      return new Response("OK");
    }

    return new Response("Livegram Worker running");

    // ===== 工具函数 =====
    async function sendMessage(chat_id, text) {
      try {
        const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id, text }),
        });
        
        if (!response.ok) {
          console.error("Failed to send message:", await response.text());
        }
      } catch (error) {
        console.error("Error sending message:", error);
      }
    }

    async function forwardMessage(fromChatId, messageId, adminId) {
      try {
        const response = await fetch(`${TELEGRAM_API}/forwardMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: adminId,
            from_chat_id: fromChatId,
            message_id: messageId
          }),
        });
        
        if (!response.ok) {
          console.error("Failed to forward message:", await response.text());
        }
      } catch (error) {
        console.error("Error forwarding message:", error);
      }
    }

    async function sendVerifyButton(chat_id) {
      try {
        const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id,
            text: "🤖🤖 为了安全，请点击下面的按钮验证你是真人。",
            reply_markup: {
              inline_keyboard: [
                [{ text: "I'm not a bot ✅", callback_data: "verify_human" }]
              ]
            }
          }),
        });
        
        if (!response.ok) {
          console.error("Failed to send verify button:", await response.text());
        }
      } catch (error) {
        console.error("Error sending verify button:", error);
      }
    }

    // ===== 新增媒体消息发送函数 =====
    async function sendPhoto(chat_id, photo, caption = "") {
      try {
        const response = await fetch(`${TELEGRAM_API}/sendPhoto`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id, photo, caption }),
        });
        
        if (!response.ok) {
          console.error("Failed to send photo:", await response.text());
        }
      } catch (error) {
        console.error("Error sending photo:", error);
      }
    }

    async function sendVideo(chat_id, video, caption = "") {
      try {
        const response = await fetch(`${TELEGRAM_API}/sendVideo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id, video, caption }),
        });
        
        if (!response.ok) {
          console.error("Failed to send video:", await response.text());
        }
      } catch (error) {
        console.error("Error sending video:", error);
      }
    }

    async function sendDocument(chat_id, document, caption = "") {
      try {
        const response = await fetch(`${TELEGRAM_API}/sendDocument`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id, document, caption }),
        });
        
        if (!response.ok) {
          console.error("Failed to send document:", await response.text());
        }
      } catch (error) {
        console.error("Error sending document:", error);
      }
    }

    async function sendAudio(chat_id, audio, caption = "") {
      try {
        const response = await fetch(`${TELEGRAM_API}/sendAudio`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id, audio, caption }),
        });
        
        if (!response.ok) {
          console.error("Failed to send audio:", await response.text());
        }
      } catch (error) {
        console.error("Error sending audio:", error);
      }
    }

    async function sendVoice(chat_id, voice) {
      try {
        const response = await fetch(`${TELEGRAM_API}/sendVoice`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id, voice }),
        });
        
        if (!response.ok) {
          console.error("Failed to send voice:", await response.text());
        }
      } catch (error) {
        console.error("Error sending voice:", error);
      }
    }

    async function sendSticker(chat_id, sticker) {
      try {
        const response = await fetch(`${TELEGRAM_API}/sendSticker`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id, sticker }),
        });
        
        if (!response.ok) {
          console.error("Failed to send sticker:", await response.text());
        }
      } catch (error) {
        console.error("Error sending sticker:", error);
      }
    }
  }
};
