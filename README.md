# programming-battle-jyanken

プログラミング言語どうしが戦う、じゃんけん式 1 対 1 チャンバラゲーム（Phaser 4 + TypeScript + Vite + Effect）。

> 7 キャラ・ベストオブ 3・スキル・隠れデメリット（実績）・演出・**オンラインのルーム対戦**まで実装済み。

## ルール

- 手は **斬撃 > 刺突 > 打撃 > 斬撃** の三すくみ（＝ ✊グー > ✌️チョキ > ✋パー > ✊グー）。両者が伏せて選び、そろってからオープンする
- ダメージ：斬撃 20 ／ 刺突 15 ／ 打撃 10 ＋ 相手の手札を 1 枚捨て札へ。あいこは両者ノーダメージで 1 枚ずつ消費
- 負けるのは **HP 0 のときだけ**。手札 0 は「素手」：好きな手を出せるが与ダメージ 1/2（Java・Haskell は 1/3、端数切り上げ）
- ベストオブ 3（2 本先取）。試合ごとに HP・手札・スキル・隠れデメリットの累積をリセット
- 捨て札は互いに公開。相手の手札は手選択中だけ合計枚数が見える（Python のスキル後は内訳も）

| キャラ | HP | 斬/突/打 | スキル（自動発動） |
|---|---|---|---|
| Java ☕ | 120 | 3/4/4 | ガベージコレクション：毎ターン 20% で捨て札から 1 枚回収（何度でも）。30% で STW「GCが走った！！」→ 次ターン与ダメ -10 |
| Haskell 🟣 | 110 | 3/5/4 | 遅延評価：被ダメージをサンクに溜める。勝つと最古のサンクを破棄。手札 0 で一括評価（1 回） |
| C 🔵 | 90 | 6/3/3 | 動的メモリ確保：手札 5 枚以下でランダムな 1 枚を一時追加 |
| C++ 🔷 | 85 | 7/3/2 | RAII：HP 50% 以下で、そのターン使ったカードを回収（次ターン使用不可） |
| JavaScript 🟨 | 85 | 6/2/4 | イベントループ：3 ターン目以降・手札 4 枚以上で、両者の手の確定後・オープン前に追加の 1 手（相手の手は見えない） |
| Python 🐍 | 80 | 4/4/4 | 動的型付け：相手の手札 6 枚以下で、相手の手札内訳を試合中ずっと公開 |
| PHP 🐘 | 75 | 5/3/4 | リクエストライフサイクル：相手の手札 6 枚以下で、相手の手札を 2 枚破壊 |

各キャラには通常の UI に出ない**隠れデメリット**がある（Python・Haskell を除く）。初めて発動すると
「🏆 実績解除」が出て、キャラ選択画面の「実績 (Q)」から開発現場での実問題を読める（解除状態はローカルストレージに保存）。

### 仕様に無かった点の決定

- **上限ターン**：HP 以外で負けないため、両者素手のあいこが続くと終わらない。1 試合 60 ターンで HP 割合が高い方の勝ち、同率は引き分け
- **引き分けの試合**（相打ち・上限ターンで同率）はどちらにも 1 本入らず、次の試合へ
- **C の不発**：C の攻撃が出ず、相手の手が一方的に通る
- **C++ の解放漏れ**：その時点の手札枚数から 1 枚減らした値を上限にし、超えた分を捨て札へ。以後、RAII・GC で戻しても上限を超えない
- **JavaScript の 2 手**：どちらかが相手に勝てば勝ち（もう一方が負けていても）。両方勝つならダメージが大きい方
- **Haskell の強制評価後**は遅延評価が終わり、以後のダメージは HP に直接入る
- **STW の -10** は素手補正の後に引く（0 未満にはならない）
- **隠れデメリットの条件**（「手札 0 のターン」など）は手を選んだ時点の手札で判定する
- **ターンの順序**（オフライン・オンライン共通）：手の確定 → スキル → 隠れデメリット →（イベントループの追加の 1 手）→ オープン → 判定 → ダメージ → 勝敗。
  スキルの発動条件はターン開始時（手を出す前）の状態で判定する
- **C の動的メモリ確保**：手の確定後に発動するので、追加したカードを使えるのは次のターン。そのターンに使わなければターン終了時に捨て札へ
- **Java の GC** はこのターンに出したカードは回収しない（オープン前に手がばれるため）

## 実行

npm workspaces のモノレポ（Node.js 22）。

```sh
npm install
npm run dev          # クライアント（Vite）: http://localhost:5173/
npm run dev:server   # 対戦サーバー（WebSocket）: ws://localhost:8787（PORT で変更）
npm run build        # クライアントの本番ビルド → packages/client/dist/
npm run build:server # サーバーを 1 ファイルにバンドル → packages/server/dist/server.mjs
npm run check        # typecheck + lint + test（全パッケージ）
```

オフライン（CPU 戦）はクライアントだけで動く。オンライン対戦にはサーバーも起動する。

### オンライン対戦

1. キャラ選択画面右上の「🌐 オンライン (O)」でロビーへ
2. キャラを選び「ルームを作る (N)」→ 6 文字のルームコードが出る（「招待リンクをコピー (L)」で `?room=XXXXXX` 付きの URL も作れる）
3. 相手は「コードで参加 (J)」でコードを入力（招待リンクなら入力済み）して Enter
4. そろったらルームの作成者が「開始 (Enter)」。ベストオブ 3 の後、両者が「再戦 (R)」を押すと同じキャラで次のマッチ

クライアントの接続先はビルド時の `VITE_SERVER_URL`（例 `VITE_SERVER_URL=wss://xxx.onrender.com npm run build`）。
未指定なら、ページと同じホストの 8787 番に `ws://`（https のページなら `wss://`）でつなぐ。
通信が切れても 30 秒以内なら自動で再接続して続きから戻る（sessionToken はローカルストレージにだけ保存）。

### デプロイ（サーバー：Render ／ クライアント：Cloudflare Pages）

サーバーはルームの状態をメモリに持つ常駐プロセスなので Render の Web Service で動かし、
クライアント（静的サイト）は Cloudflare Pages で配信する。

**1. サーバー（Render）** — ルートの `render.yaml`（Blueprint）で構成済み

1. Render のダッシュボードで「New → Blueprint」→ このリポジトリを選ぶ
2. 環境変数 `ALLOWED_ORIGINS` に Pages の URL を入れる（カンマ区切り。`*.` でプレビュー環境のサブドメインも許可できる）
   例：`https://programming-battle-jyanken.pages.dev,https://*.programming-battle-jyanken.pages.dev`
3. デプロイが終わると `https://<サービス名>.onrender.com/healthz` が `{"ok":true,"rooms":0}` を返す

| 項目 | 値（`render.yaml`） |
| --- | --- |
| Runtime / Region / Plan | Node / Singapore（日本に最も近い）/ Free |
| Build command | `npm ci --include=dev && npm run build:server` |
| Start command | `node packages/server/dist/server.mjs` |
| Health check | `GET /healthz`（WebSocket 以外の HTTP は 426） |
| 環境変数 | `NODE_VERSION=22`、`ALLOWED_ORIGINS`（`PORT` は Render が設定） |
| 自動デプロイ | `main` の `packages/server`・`packages/shared`・lockfile・`render.yaml` が変わったときだけ |

注意：

- **無料プランは 15 分アクセスが無いと休止**し、次の接続で起動するまで 1 分ほどかかる。
  クライアントは起動時に `/healthz` を 1 回叩いてサーバーを起こし、つながるまで 2 秒おきに再試行する（ロビーに「再試行しています」と出る）
- **再デプロイ・再起動でルームは消える**（メモリ上の状態のため）。終了時（SIGTERM）は全接続を 1012（Service Restart）で閉じ、
  クライアントは再接続して `SessionExpired` を受け取り、ロビーへ戻る
- ルームを 1 プロセスで持つので、インスタンスは 1 台（`numInstances: 1`）。水平分割はしない

**2. クライアント（Cloudflare Pages）**

| 項目 | 値 |
| --- | --- |
| Build command | `npm run build` |
| Build output directory | `packages/client/dist` |
| 環境変数 | `VITE_SERVER_URL=wss://<サービス名>.onrender.com`（ビルド時に埋め込まれる） |
| Node.js のバージョン | `.nvmrc` の 22 |

CLI から直接上げる場合は `VITE_SERVER_URL=wss://<サービス名>.onrender.com npm run build && npx wrangler deploy`
（ルートの `wrangler.jsonc` が `packages/client/dist` を配信する）。

実績の解除状態はブラウザのローカルストレージに保存されるので、ドメインごと・ブラウザごとに別になる。

起動するとキャラクター選択画面から始まる（自分 → CPU の順に選ぶ。同キャラ対戦も可）。

ブラウザでは開発用に URL クエリも使える（`player` と `cpu` は両方指定したときだけ選択画面を飛ばす）：
`/?player=python&cpu=haskell&seed=42&quality=high`
（キャラ ID: `java` / `haskell` / `c` / `cpp` / `javascript` / `python` / `php`。seed 省略時は時刻から決定。
`quality` は描画品質で `auto`（既定）/ `high` / `low`。
開発ビルドのみ `chance=always|never` で確率判定をすべて成立／不成立にできる：隠れデメリットや STW の確認用）

### 操作（クリックとキーボードはいつでも併用可）

キャラクター選択：

| 操作 | クリック | キーボード |
| --- | --- | --- |
| キャラを選ぶ | カードにカーソルを乗せる | **A / D** |
| 決定 | カードをクリック | **J** |
| 自分の選択に戻る | 「戻る」ボタン | **K** |
| ランダムに決定 | 「おまかせ」ボタン | **R** |
| 実績画面 | 「実績」ボタン | **Q** |

対戦：

| 操作 | クリック | キーボード |
| --- | --- | --- |
| 手を選ぶ | カードにカーソルを乗せる | **A / D** |
| 決定（イベントループの追加の 1 手も同じ） | カードをクリック | **J** |
| 同じ対戦をもう一度（マッチ終了後） | 「リスタート」ボタン | **R** |
| キャラ選択へ戻る（マッチ終了後） | 「キャラ選択へ」ボタン | **C** |

## 演出

- 画面遷移：フェード、決定時の VS スプラッシュ
- 背景：キャラ色のグラデーション＋グリッド＋ビネット、下から漂うコード記号と光の粒
- 対戦：アバターのスライドイン・待機中の呼吸、手札のホバーで浮き上がり＋光彩、
  オープン時のカードめくり→衝突→火花・画面揺れ・被弾フラッシュ・ダメージ数値、
  HP バーの残像とカウントダウン、スキル発動の帯、決着時の紙吹雪とグレースケール
- OS の「視差効果を減らす」（`prefers-reduced-motion`）が有効なら、揺れ・点滅・常時アニメーションを抑える
- 描画品質の自動調整：起動直後の実測 fps が 28 未満なら、全画面の背景画像と漂う記号を外す
  （GPU のない環境では、全画面を塗る処理だけで fps が大きく落ちるため）。
  背景・ビネット・光彩は Canvas 2D で一度だけテクスチャに焼き込み、WebGL の Filters は常駐させない

## 構成

```
packages/
  shared/src/           クライアントとサーバーの共通部分（Phaser 非依存・すべて Effect）
    move.ts             Move（Slash/Thrust/Bash）と判定テーブル Record<Move, Record<Move, Outcome>>
    balance.ts          バランス値（HP・カード枚数・ダメージ・素手補正・スキル/隠れデメリットの確率と閾値）
    characters.ts       CharacterSpec の Schema とキャラデータ（7 体）
    skills.ts / traits.ts / conditions.ts  スキル・隠れデメリット・発動条件
    achievements.ts     Achievement の Schema・データ・AchievementStore サービス
    state.ts            GameState / FighterState と不変条件チェック（INV-1〜5）
    engine.ts           ターン解決（固定順序・乱数の呼び出し順も固定＝決定論的）
    battle.ts           オフライン版の進行（入力の取得と演出への通知）・ベストオブ 3
    view.ts             視点ごとの View（相手の手札内訳・隠れデメリットの内部状態は型レベルで隔離）
    protocol.ts         オンラインのメッセージ（Effect.Schema の判別共用体）
    fsm.ts              Room / Match の状態機械（全セルを Record で定義。表に無い遷移は InvalidTransition）
    publicize.ts        エンジンの状態 → 公開情報（サーバーから出る情報の唯一の出口）
    random.ts           RandomService（matchId から導くシード・テスト用スタブ）
  server/src/           対戦サーバー（Node.js + Effect + @effect/platform の SocketServer）
    hub.ts              ルーム・セッション・タイマー・採番・流量制限（通信手段に非依存）
    ws.ts               HTTP（/healthz）＋ WebSocket の待ち受けと Hub をつなぐ薄い層（Origin の許可リスト・SIGTERM で全接続を閉じる）
    errors.ts / config.ts / ids.ts / main.ts
  server/test/          偽の接続と TestClock で、採番・冪等性・タイムアウト・再接続・決定論を検証
  client/src/
    game/               Phaser ホスト（CPU 戦・キャラ選択・実績・演出）
    online/             オンライン対戦（接続・ロビー・対戦画面・サーバーのデータ → 表示用 View の変換）
  client/public/logos/  各言語のロゴ（SVG）
```

## オンライン対戦の設計

- **サーバー権威**：手の検証・ダメージ計算・乱数・タイムアウトはすべてサーバー。クライアントは乱数を振らず、時計は残り時間の表示にしか使わない
- 乱数は `matchId`（UUIDv4）の FNV-1a ハッシュをシードにした mulberry32。呼び出し順はエンジンが固定するので、同じ matchId・同じ入力列なら同じ結果になる
- 全操作を 1 本のロックで直列化。`TurnResolved` は 1 つのオブジェクトを両者に送る（INV-7）。手選択中は相手の手の中身を送らない（INV-6：型の上でも入る場所が無い）
- メッセージは `clientSeq` / `serverSeq` 付き。同じ `clientSeq` の再送には前回と同じ応答（同じ `serverSeq`）をそのまま返し、古い `clientSeq` は `InvalidSequence`（INV-8）
- タイマー：手選択 15 秒（未選択はランダム代理）、再接続猶予 30 秒（超過で切断側の負け）、放置 WAITING 300 秒・READY 60 秒・FINISHED 60 秒でルームを閉じる、ハートビート 10 秒
- 流量制限：1 秒 5 件を超えると `RateLimited`、3 回で切断。不正なメッセージ 5 回でも切断。それ以外のエラーは型付きの `Error` を返すだけで切断しない
- 二重接続は新しい接続を残し、古い接続を閉じる

仕様からの追加・解釈：

- メッセージを 3 つ追加：`StartMatch`（READY → PLAYING。作成者のみ）、`SelectExtraMove`（イベントループの追加の 1 手）、`Heartbeat`
- マッチの状態に `EXTRA_SELECTING`（両者の手の確定後・オープン前に、追加の 1 手を待つ）を追加。この間の同期では、相手が伏せたカードを捨て札から 1 枚隠す
- 待機中（WAITING / READY / FINISHED）の退出・切断はルームを閉じる（READY → WAITING に戻さない）。試合中の退出は即負け（`Forfeit`）
- 再戦は両者の `Rematch` がそろったら、READY を経てすぐに次のマッチを始める（勝ち数はリセット）
- エラーコードに無い「その手は出せない」は `InvalidMessage`（不正メッセージの累積には数えない）
- C の UB 補正は対象キャラが無いため省略

## キャラクターの追加

1. `balance.ts` の `Balance.characters` と `RAW_BALANCE` に数値を追加
2. `characters.ts` の `rawCharacters` に定義を追加。スキルは `skillId`・`kind`・`condition`（条件の原子の配列）・`activate`（効果）の組み合わせで記述し、
   隠れデメリットがあれば `hiddenTrait` と、`achievements.ts` に対応する実績を追加
3. 新しい種類の条件・効果が必要なら `conditions.ts` / `skills.ts` / `traits.ts` の Union に足す
   （`switch` の網羅性チェックにより、実装漏れはコンパイルエラーになる）

## 実装メモ

- `Effect.assert` は Effect 3 に存在しないため、同等の `assertInvariant`（偽なら `Effect.dieMessage`）を `state.ts` に定義している。
  ターン境界ごとに HP 範囲・手札枚数・used フラグ・捨て札合計（手札＋捨て札＝初期＋生成）・サンク累積ダメージを検証する
  （破壊されたカードも捨て札へ行くので、INV-3 は「手札＋捨て札＝初期＋生成」として表している）
- `@effect/vitest` は vitest 3 系向けのため使わず、Effect の `TestClock` / `TestContext` を直接使っている

## ロゴについて

`public/logos/` の各言語ロゴは [devicon](https://github.com/devicons/devicon)（MIT License, `public/logos/LICENSE-devicon.txt`）の
“original” 版。MIT が適用されるのは devicon の収録物としての部分で、**ロゴそのものは各権利者の商標**。

- Java：Oracle の商標。一般向けに公開する場合は Oracle の商標ガイドラインの確認が必要
- C：公式ロゴは存在しないため、広く使われている非公式ロゴ
- JavaScript：公式ロゴは存在しないため、コミュニティで広く使われている「JS」ロゴ
- Python（PSF）・PHP・C++（Standard C++ Foundation）・Haskell：各団体の利用規約に従う

試験公開の範囲を超えて配布する場合は、各ガイドラインを確認するか、`logoKey` の画像を差し替えること
（`public/logos/<logoKey>.svg` を置き換えるだけで反映される）。
