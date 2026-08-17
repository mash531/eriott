-- 岡部エリオット: メンバーのキャラクター学習機能 用テーブル
-- Supabaseのダッシュボード「SQL Editor」で、このファイルの中身を全部貼り付けて実行してください。

-- グループ内の発言ログ（要約に使ったら自動で削除されるので、ここには基本的に直近分だけ溜まります）
create table if not exists member_messages (
  id bigint generated always as identity primary key,
  group_id text not null,
  user_id text not null,
  display_name text not null,
  text text not null,
  created_at timestamptz not null default now()
);

create index if not exists member_messages_group_user_idx
  on member_messages (group_id, user_id, created_at);

-- メンバーごとのキャラクター・プロフィール（要約結果を保存する場所）
create table if not exists member_profiles (
  group_id text not null,
  user_id text not null,
  display_name text not null,
  profile text not null default '',
  message_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
