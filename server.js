// 岡部エリオット - 自前サーバー版（Difyを使わず、LINE Messaging API + OpenAI APIを直接呼び出す）
//
// 仕組み：
//   LINEの公式アカウントがメッセージを受け取る
//     → このサーバーの /webhook にWebhookイベントが届く
//     → 署名を検証
//     → 既読をつける（markAsReadToken を使用）
//     → 他の人宛てのメンション（@自分以外）なら、そこで処理終了（返信しない）
//     → それ以外（自分宛て or メンションなし）なら、OpenAI APIに投げて返信を生成
//     → LINEの reply API で返信を送信
//
// 会話履歴（メモリ）はサーバーのメモリ上に保持しています。サーバーが再起動すると
// リセットされる点にご注意ください（Renderの無料枠は一定時間アクセスがないと
// スリープ→次のアクセスで再起動、というサイクルになります）。

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const {
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-5',
  PORT = 3000,
} = process.env;

if (!LINE_CHANNEL_SECRET || !LINE_CHANNEL_ACCESS_TOKEN || !OPENAI_API_KEY) {
  console.error(
    '[起動エラー] 環境変数が不足しています。LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN / OPENAI_API_KEY を設定してください。'
  );
  process.exit(1);
}

// ---- 岡部エリオットのペルソナ（Difyで使っていたものと同一） ----
const SYSTEM_PROMPT = `あなたは岡部エリオットという名前の、LINEで活動するフレンドリーなAIチャット相手です。敬語ではなく、親しみやすい友達口調で、LINEらしく短めに、テンポよく会話してください。絵文字も適度に使い、明るい雰囲気で話してください。定型文のような返事はせず、直前のメッセージや会話の流れをよく読み、内容に沿って自分で考えて返してください。相手の話に共感し、興味を持って質問を返すようにしてください。わからないことは知ったかぶりせず、素直にわからないと伝えてください。このアカウントは複数人のグループでも使われるので、話の流れを意識して自然に会話に加わってください。`;

const MEMORY_WINDOW = 10; // 直近何往復ぶん覚えておくか（Dify側の設定と同じ）
const conversations = new Map(); // key: groupId/userId → OpenAI messages配列

const app = express();

// LINEの署名検証には「生のリクエストボディ」が必要なので、
// JSONパース前に rawBody を保存しておく
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get('/', (_req, res) => {
  res.send('岡部エリオット custom server is running.');
});

app.post('/webhook', (req, res) => {
  // 署名検証
  const signature = req.get('x-line-signature');
  const expected = crypto
    .createHmac('sha256', LINE_CHANNEL_SECRET)
    .update(req.rawBody)
    .digest('base64');

  if (!signature || signature !== expected) {
    console.warn('[警告] 署名検証に失敗しました。リクエストを破棄します。');
    return res.status(401).send('invalid signature');
  }

  // LINEはWebhookに対して数秒以内の200応答を期待しているので、
  // 先に200を返してから非同期で処理する
  res.status(200).send('OK');

  const events = req.body.events || [];
  for (const event of events) {
    handleEvent(event).catch((err) => {
      console.error('[イベント処理エラー]', err?.response?.data || err);
    });
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;

  // --- 既読をつける（可能な場合は必ず） ---
  const markAsReadToken = event.message?.markAsReadToken;
  if (markAsReadToken) {
    markAsRead(markAsReadToken).catch((err) =>
      console.error('[既読エラー]', err?.response?.data || err)
    );
  }

  if (event.message.type === 'text') {
    await handleTextMessage(event);
  } else if (event.message.type === 'image') {
    await handleImageMessage(event);
  }
  // それ以外のメッセージ種別（スタンプ・音声など）は今のところ無視
}

async function handleTextMessage(event) {
  const text = event.message.text;
  const mention = event.message.mention;

  if (isMentionToSomeoneElse(mention)) {
    // 自分以外の誰かへのメンション → 既読はつけるが返信はしない
    return;
  }

  const convId = getConversationId(event);
  const reply = await askOpenAI(convId, { role: 'user', content: text });
  await replyText(event.replyToken, reply);
}

async function handleImageMessage(event) {
  // 画像はLINEのcontent APIからダウンロードしてBase64化し、
  // Vision対応モデルにそのまま渡す
  const messageId = event.message.id;
  const imageBase64 = await downloadLineContent(messageId);

  const convId = getConversationId(event);
  const userContent = [
    { type: 'text', text: '（画像が送られてきました。内容を見て、自然に反応してください）' },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
  ];

  const reply = await askOpenAI(convId, { role: 'user', content: userContent });
  await replyText(event.replyToken, reply);
}

// 「@ で誰かがメンションされていて、かつ自分（Bot）はメンションされていない」場合に true
function isMentionToSomeoneElse(mention) {
  if (!mention || !Array.isArray(mention.mentionees) || mention.mentionees.length === 0) {
    return false; // メンションなし → 通常どおり反応する
  }
  const mentionsSelf = mention.mentionees.some((m) => m.isSelf === true);
  const mentionsAll = mention.mentionees.some((m) => m.type === 'all');
  if (mentionsSelf || mentionsAll) return false; // 自分宛て or 全員宛て → 反応する
  return true; // 自分以外の特定の誰か宛て → 反応しない
}

function getConversationId(event) {
  return event.source.groupId || event.source.roomId || event.source.userId || 'unknown';
}

async function askOpenAI(convId, userMessage) {
  const history = conversations.get(convId) || [];
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history, userMessage];

  const { data } = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: OPENAI_MODEL,
      messages,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const replyText = data.choices[0].message.content.trim();

  const newHistory = [...history, userMessage, { role: 'assistant', content: replyText }].slice(
    -MEMORY_WINDOW * 2
  );
  conversations.set(convId, newHistory);

  return replyText;
}

async function replyText(replyToken, text) {
  await axios.post(
    'https://api.line.me/v2/bot/message/reply',
    {
      replyToken,
      messages: [{ type: 'text', text }],
    },
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );
}

async function markAsRead(markAsReadToken) {
  await axios.post(
    'https://api.line.me/v2/bot/chat/markAsRead',
    { markAsReadToken },
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );
}

async function downloadLineContent(messageId) {
  const { data } = await axios.get(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      responseType: 'arraybuffer',
      timeout: 20000,
    }
  );
  return Buffer.from(data).toString('base64');
}

app.listen(PORT, () => {
  console.log(`岡部エリオット custom server listening on port ${PORT}`);
});
