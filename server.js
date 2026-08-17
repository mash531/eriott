// 岡部エリオット - 自前サーバー版（Difyを使わず、LINE Messaging API + OpenAI APIを直接呼び出す）
//
// 仕組み：
//   LINEの公式アカウントがメッセージを受け取る
//     → このサーバーの /webhook にWebhookイベントが届く
//     → 署名を検証
//     → 既読をつける（markAsReadToken を使用。反応する/しないに関わらず必ず実行）
//     → 「本文に『エリオット』という文字が含まれる」または「エリオット自身のメッセージへの
//       リプライ（引用返信）」のときだけ、OpenAI APIに投げて返信を生成する
//       （それ以外は既読だけつけて無反応。LINEの@メンション機能はグループによって候補に
//       出てこないなど不安定なため、文字列一致方式に変更）
//     → LINEの reply API で返信を送信し、送ったメッセージIDを覚えておく
//       （次に届くリプライが「エリオット宛てか」を判定するため）
//
// 会話履歴（メモリ）・時刻情報・リプライ判定用のメッセージIDは、いずれもサーバーの
// メモリ上に保持しています。サーバーが再起動するとリセットされる点にご注意ください
// （Renderの無料枠は一定時間アクセスがないとスリープ→次のアクセスで再起動、という
// サイクルになります）。

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
const lastMessageAt = new Map(); // key: groupId/userId → 直前のメッセージ時刻（Dateオブジェクト）
const botMessageIds = new Map(); // key: groupId/userId → エリオット自身が送った直近のメッセージID集合（Set）

// エリオットが送ったメッセージのIDを覚えておく（「リプライ」判定に使う）
function rememberBotMessageIds(convId, sentMessages) {
  if (!Array.isArray(sentMessages)) return;
  const ids = botMessageIds.get(convId) || new Set();
  for (const m of sentMessages) {
    if (m?.id) ids.add(m.id);
  }
  // 際限なく増えないよう、直近50件程度に丸める
  while (ids.size > 50) {
    ids.delete(ids.values().next().value);
  }
  botMessageIds.set(convId, ids);
}

// 受信したメッセージが「エリオット自身の過去メッセージへのリプライ（引用返信）」かどうか
function isReplyToBot(convId, quotedMessageId) {
  if (!quotedMessageId) return false;
  const ids = botMessageIds.get(convId);
  return !!ids && ids.has(quotedMessageId);
}

// 現在時刻を「2026年8月17日(月) 14:30」のような日本語表記にする
function formatJstNow(date) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}年${get('month')}月${get('day')}日(${get('weekday')}) ${get('hour')}:${get(
    'minute'
  )}`;
}

// 経過時間を「約3時間ぶり」のような日本語表現にする（直近すぎる場合はnull）
function describeGap(ms) {
  const minutes = ms / 60000;
  if (minutes < 15) return null;
  const hours = minutes / 60;
  if (hours < 1) return `約${Math.round(minutes)}分ぶり`;
  const days = hours / 24;
  if (days < 1) return `約${Math.round(hours)}時間ぶり`;
  if (days < 14) return `約${Math.round(days)}日ぶり`;
  return `約${Math.round(days / 7)}週間ぶり`;
}

// システムプロンプトに付け足す「時間の文脈」を組み立てる
function buildTimeContext(convId, now) {
  let context = `現在の日時は${formatJstNow(
    now
  )}です。時間帯（朝・昼・夜など）に応じた挨拶や話し方を、不自然にならない範囲で意識してください。`;

  const last = lastMessageAt.get(convId);
  if (last) {
    const gapDesc = describeGap(now - last);
    if (gapDesc) {
      context += `\nこの相手との前回のやり取りから${gapDesc}経っています。時間が空いたことに軽く触れても構いませんが、毎回大げさに反応する必要はありません。`;
    }
  }
  return context;
}

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
  const convId = getConversationId(event);

  // 反応するのは「本文に『エリオット』という文字が含まれる」か
  // 「エリオットのメッセージへのリプライ」のときだけ
  // （LINEの@メンション機能は、グループによっては候補に出ないなど不安定なため使わない）
  const mentionsName = containsBotName(text);
  const replyingToBot = isReplyToBot(convId, event.message.quotedMessageId);
  if (!mentionsName && !replyingToBot) {
    return; // 既読はつけるが、返信はしない
  }

  const reply = await askOpenAI(convId, { role: 'user', content: text });
  const sent = await sendReply(event.replyToken, reply);
  rememberBotMessageIds(convId, sent?.sentMessages);
}

async function handleImageMessage(event) {
  const convId = getConversationId(event);

  // 画像には@メンションの概念がないので、エリオットのメッセージへのリプライのときだけ反応する
  if (!isReplyToBot(convId, event.message.quotedMessageId)) {
    return;
  }

  // 画像はLINEのcontent APIからダウンロードしてBase64化し、
  // Vision対応モデルにそのまま渡す
  const messageId = event.message.id;
  const imageBase64 = await downloadLineContent(messageId);

  const userContent = [
    { type: 'text', text: '（画像が送られてきました。内容を見て、自然に反応してください）' },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
  ];

  const reply = await askOpenAI(convId, { role: 'user', content: userContent });
  const sent = await sendReply(event.replyToken, reply);
  rememberBotMessageIds(convId, sent?.sentMessages);
}

// 本文に「エリオット」という文字列が含まれているか（「岡部エリオット」も含む）
function containsBotName(text) {
  return typeof text === 'string' && text.includes('エリオット');
}

function getConversationId(event) {
  return event.source.groupId || event.source.roomId || event.source.userId || 'unknown';
}

async function askOpenAI(convId, userMessage) {
  const now = new Date();
  const history = conversations.get(convId) || [];
  const timeContext = buildTimeContext(convId, now);
  const messages = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${timeContext}` },
    ...history,
    userMessage,
  ];

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
  lastMessageAt.set(convId, now);

  return replyText;
}

async function sendReply(replyToken, text) {
  const { data } = await axios.post(
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
  return data; // { sentMessages: [{ id, quoteToken }, ...] }
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
