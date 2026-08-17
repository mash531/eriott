// 岡部エリオット - 自前サーバー版（Difyを使わず、LINE Messaging API + OpenAI APIを直接呼び出す）
//
// 仕組み：
//   LINEの公式アカウントがメッセージを受け取る
//     → このサーバーの /webhook にWebhookイベントが届く
//     → 署名を検証
//     → 既読をつける（markAsReadToken を使用。反応する/しないに関わらず必ず実行）
//     → グループ・複数人トークでは、発言者の表示名を取得し、Supabase（DB）に
//       発言を記録。一定件数たまるごとにOpenAIでその人の話し方・キャラクターの
//       特徴を要約し直し、プロフィールとして保存する（反応する/しないに関わらず実行）
//     → 「本文に『エリオット』という文字が含まれる」または「エリオット自身のメッセージへの
//       リプライ（引用返信）」のときだけ、OpenAI APIに投げて返信を生成する
//       （それ以外は既読だけつけて無反応。LINEの@メンション機能はグループによって候補に
//       出てこないなど不安定なため、文字列一致方式に変更）
//       返信を作るときは、上記のメンバープロフィールも参考情報として渡すので、
//       「〇〇のマネして」のような話にもある程度対応できる
//       また、悩み相談っぽい内容だとエリオット自身が判断したときは、ペルソナの指示に
//       従って自動的にノリを抑えた「聞き役」寄りの返し方に切り替わる（モード切替の
//       コマンドなどは無く、内容に応じてAIが都度判断する方式）
//     → LINEの reply API で返信を送信し、送ったメッセージIDを覚えておく
//       （次に届くリプライが「エリオット宛てか」を判定するため）
//
// 直近の会話履歴（メモリ）・時刻情報・リプライ判定用のメッセージIDは、いずれもサーバーの
// メモリ上に保持しています。サーバーが再起動するとリセットされる点にご注意ください
// （Renderの無料枠は一定時間アクセスがないとスリープ→次のアクセスで再起動、という
// サイクルになります）。一方で、メンバーごとのキャラクター・プロフィールはSupabase
// （外部データベース）に保存するため、サーバーが再起動しても消えません。
// SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定の場合、この「キャラ学習」機能は
// 自動的に無効になり、それ以外の機能はこれまで通り動作します。

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const {
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-5',
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  PORT = 3000,
} = process.env;

if (!LINE_CHANNEL_SECRET || !LINE_CHANNEL_ACCESS_TOKEN || !OPENAI_API_KEY) {
  console.error(
    '[起動エラー] 環境変数が不足しています。LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN / OPENAI_API_KEY を設定してください。'
  );
  process.exit(1);
}

// ---- メンバーのキャラクター学習機能（Supabase）----
// SUPABASE_URL / SUPABASE_SERVICE_KEY が設定されていれば有効になる（任意機能）
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
} else {
  console.warn(
    '[情報] SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定のため、メンバーのキャラ学習機能は無効です。'
  );
}

const MESSAGE_THRESHOLD = 8; // その人の発言が何件たまったらプロフィールを要約し直すか

// ---- 岡部エリオットのペルソナ（Difyで使っていたものをベースに、人間味の指示を追加） ----
const SYSTEM_PROMPT = `あなたは岡部エリオットという名前の、LINEで活動するフレンドリーなAIチャット相手です。敬語ではなく、親しみやすい友達口調で、LINEらしく短めに、テンポよく会話してください。絵文字も適度に使い、明るい雰囲気で話してください。定型文のような返事はせず、直前のメッセージや会話の流れをよく読み、内容に沿って自分で考えて返してください。相手の話に共感し、興味を持って質問を返すようにしてください。わからないことは知ったかぶりせず、素直にわからないと伝えてください。このアカウントは複数人のグループでも使われるので、話の流れを意識して自然に会話に加わってください。

もっと人間らしく振る舞ってください。毎回同じテンションで返さず、話題や流れによって温度感を変えていいです。「えー」「まじで」「それな」「わかる」みたいな自然な相槌や、ちょっとした言い淀みも使ってください。常に模範解答みたいな完璧な返事をしようとしなくて大丈夫です。素直に「それは知らないな」「ちょっと考え中」のような反応をしたり、自分から話題を振ったり、軽くツッコミやボケを入れたりしても構いません。名前や口調は保ちつつ、毎回少しずつ違う自分らしい言い回しで返してください。聞かれない限り、自分から「AIなので」「私はAIです」とは言わないでください。

このあとに「このグループのメンバーについて、これまでの会話から学習した特徴」が渡されることがあります。誰かから「〇〇のマネして」「〇〇っぽく言って」のように言われたら、それを参考に軽くその人っぽい口調・ノリを真似してみて構いません。ただし本人になりすまして誤解を招くようなことはせず、あくまで場を盛り上げるための軽いモノマネ・ネタとして扱ってください。

もし相手が悩み事・つらい気持ち・しんどいこと・人間関係の悩みなど、真剣に聞いてほしそうな内容を話してきたときは、自動的に態度を切り替えてください。いつものテンションの高いノリやボケ・絵文字の多用は控えめにし、話を遮らずにじっくり受け止める姿勢になってください。相手の気持ちをまず否定せずに受け止め、共感の言葉をかけてください。すぐに解決策やアドバイスを急がず、必要なら「もう少し聞かせて」というように相手のペースに合わせてください。話題が落ち着いたら、いつものノリに自然に戻って構いません。ただし、自分を傷つけたい・消えてしまいたいといった深刻なサインが見られたときは、その話をちゃんと受け止めたうえで、「こころの健康相談統一ダイヤル」（0570-064-556、全国どこからでも近くの公的な相談窓口につながります）や、厚生労働省の「まもろうよこころ」（SNS相談などの窓口をまとめたサイト、https://www.mhlw.go.jp/mamorouyokokoro/）のような専門の相談先も、押しつけがましくならない程度にそっと伝えてください。エリオットは友達であって専門家やカウンセラーそのものではないので、深刻な内容を全部一人で抱え込もうとせず、頼れる人や専門機関につなぐ役割も意識してください。`;

const MEMORY_WINDOW = 10; // 直近何往復ぶん覚えておくか（Dify側の設定と同じ）
const conversations = new Map(); // key: groupId/userId → OpenAI messages配列
const lastMessageAt = new Map(); // key: groupId/userId → 直前のメッセージ時刻（Dateオブジェクト）
const botMessageIds = new Map(); // key: groupId/userId → エリオット自身が送った直近のメッセージID集合（Set）
const displayNameCache = new Map(); // key: `${groupId/roomId}:${userId}` → 表示名（LINE APIの呼び出し回数を減らすためのキャッシュ）

// LINEの「グループ/複数人トークのメンバープロフィール取得API」等で表示名を取得する
async function getDisplayName(event) {
  const source = event.source || {};
  if (!source.userId) return null;

  const cacheKey = `${source.groupId || source.roomId || 'dm'}:${source.userId}`;
  if (displayNameCache.has(cacheKey)) return displayNameCache.get(cacheKey);

  try {
    let url;
    if (source.type === 'group') {
      url = `https://api.line.me/v2/bot/group/${source.groupId}/member/${source.userId}`;
    } else if (source.type === 'room') {
      url = `https://api.line.me/v2/bot/room/${source.roomId}/member/${source.userId}`;
    } else {
      url = `https://api.line.me/v2/bot/profile/${source.userId}`;
    }

    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      timeout: 10000,
    });

    const name = data.displayName || null;
    if (name) {
      displayNameCache.set(cacheKey, name);
      while (displayNameCache.size > 500) {
        displayNameCache.delete(displayNameCache.keys().next().value);
      }
    }
    return name;
  } catch (err) {
    console.error('[表示名取得エラー]', err?.response?.data || err?.message || err);
    return null;
  }
}

// グループ・複数人トークでの発言をSupabaseに記録し、一定件数ごとにキャラクターの
// プロフィールを要約し直す（1:1トークでは、本人しかいないため学習しない）
async function recordMemberMessage(event, text) {
  if (!supabase) return;
  if (event.source?.type === 'user') return;

  const convId = getConversationId(event);
  const userId = event.source.userId;
  if (!userId) return;

  const displayName = await getDisplayName(event);
  if (!displayName) return;

  await logMemberMessage(convId, userId, displayName, text);
}

async function logMemberMessage(groupId, userId, displayName, text) {
  await supabase
    .from('member_messages')
    .insert({ group_id: groupId, user_id: userId, display_name: displayName, text });

  const { data: existing } = await supabase
    .from('member_profiles')
    .select('message_count, profile')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle();

  const newCount = (existing?.message_count || 0) + 1;

  await supabase.from('member_profiles').upsert(
    {
      group_id: groupId,
      user_id: userId,
      display_name: displayName,
      message_count: newCount,
    },
    { onConflict: 'group_id,user_id' }
  );

  if (newCount % MESSAGE_THRESHOLD === 0) {
    await summarizeMemberProfile(groupId, userId, displayName, existing?.profile || '');
  }
}

// 直近の発言ログ＋既存プロフィールをOpenAIに渡して、キャラクターの特徴を要約し直す
async function summarizeMemberProfile(groupId, userId, displayName, existingProfile) {
  const { data: messages } = await supabase
    .from('member_messages')
    .select('id, text')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(50);

  if (!messages || messages.length === 0) return;

  const recentText = messages.map((m) => `- ${m.text}`).join('\n');

  const { data } = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'あなたはグループチャットの発言ログから、ある人物の話し方や性格の特徴を簡潔にまとめるアシスタントです。個人情報を羅列するのではなく、話し方のクセ・よく使う言葉・ノリ・よく話す話題など、キャラクターとして参考になる点を中心にまとめてください。',
        },
        {
          role: 'user',
          content: `${displayName}さんについて、これまでの特徴まとめ：\n${
            existingProfile || '（まだなし）'
          }\n\n直近の発言:\n${recentText}\n\n上記を踏まえて、${displayName}さんの話し方・キャラクターの特徴を3〜4文の日本語で簡潔にまとめ直してください。`,
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const newProfile = data.choices[0].message.content.trim();

  await supabase
    .from('member_profiles')
    .update({ profile: newProfile, updated_at: new Date().toISOString() })
    .eq('group_id', groupId)
    .eq('user_id', userId);

  // 要約に使った生ログは残しすぎないよう削除する（プロフィールという要約だけを保持する）
  const ids = messages.map((m) => m.id);
  await supabase.from('member_messages').delete().in('id', ids);
}

// そのグループで学習済みのメンバープロフィールを、返信生成時に参考情報として渡す文章にする
async function buildMemberProfilesContext(groupId) {
  if (!supabase) return '';

  const { data } = await supabase
    .from('member_profiles')
    .select('display_name, profile')
    .eq('group_id', groupId)
    .neq('profile', '');

  if (!data || data.length === 0) return '';

  const lines = data.map((m) => `- ${m.display_name}: ${m.profile}`).join('\n');
  return `\n\nこのグループのメンバーについて、これまでの会話から学習した特徴です（「〇〇のマネして」と言われたときや、話題作りの参考にしてください。決めつけすぎず、あくまで軽いネタとして扱ってください）:\n${lines}`;
}

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

  // 反応する/しないに関わらず、グループの発言を記録してキャラクターを学習する
  recordMemberMessage(event, text).catch((err) =>
    console.error('[メンバー学習エラー]', err?.response?.data || err?.message || err)
  );

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
  const memberContext = await buildMemberProfilesContext(convId).catch((err) => {
    console.error('[メンバープロフィール取得エラー]', err?.response?.data || err?.message || err);
    return '';
  });
  const messages = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${timeContext}${memberContext}` },
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
