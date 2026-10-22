# programming-battle-jyanken

プログラミング言語どうしが戦う、じゃんけん式 1 対 1 チャンバラゲーム（Phaser 4 + TypeScript + Vite + Effect）。

> 7 キャラ・ベストオブ 3・スキル・隠れデメリット（実績）・演出まで実装済み。

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
| JavaScript 🟨 | 85 | 6/2/4 | イベントループ：3 ターン目以降・手札 4 枚以上で、相手の手を見て追加の 1 手 |
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

## 実行（ブラウザ）

```sh
npm install
npm run dev        # http://localhost:5173/
npm run build      # 本番ビルド → dist/
npm run preview    # dist/ をローカルで配信して確認
npm run check      # typecheck + lint + test
```

### Cloudflare Pages へのデプロイ

静的サイトとしてそのまま配信できる（サーバー側の処理は無い）。Pages の設定：

| 項目 | 値 |
| --- | --- |
| Framework preset | None（または Vite） |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node.js のバージョン | `.nvmrc` の 22 が使われる |

CLI から直接上げる場合は `npx wrangler pages deploy dist`。
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
src/
  core/                 Phaser に依存しないゲームロジック（すべて Effect）
    move.ts             Move（Slash/Thrust/Bash）と判定テーブル Record<Move, Record<Move, Outcome>>
    balance.ts          バランス値（HP・カード枚数・ダメージ・素手補正・スキル/隠れデメリットの確率と閾値）
    characters.ts       CharacterSpec の Schema とキャラデータ（7 体）
    skills.ts           SkillSpec（skillId / kind / condition / activate）の Schema と効果の実装
    traits.ts           HiddenTrait（隠れデメリット）の Schema
    achievements.ts     Achievement の Schema・データ・AchievementStore サービス
    conditions.ts       発動条件の原子（手札枚数・HP 割合・ターン数…）とその評価
    state.ts            GameState / FighterState / MatchState と不変条件チェック
    battle.ts           ターン進行（スキル判定→手選択→オープン→ダメージ→勝敗判定）・試合・ベストオブ 3
    view.ts             視点ごとの View（相手の手札内訳・隠れデメリットの内部状態は型レベルで隔離）
    events.ts           エンジン → ホストのイベント、試合結果
    services.ts         PlayerInput / CpuStrategy / BattleEvents サービス
    random.ts           RandomService とテスト用スタブ（シード固定・定数・台本）
    ai.ts               CPU（ランダム。イベントループの追加の 1 手は勝てる手を選ぶ）
    gameData.ts         起動時パース（実績との相互参照も検証）
    errors.ts           型付きエラー
  game/                 Phaser ホスト（薄い）
    SelectScene.ts      キャラクター選択 Scene
    select.ts           キャラクター選択の描画（隠れデメリットは表示しない）
    selectState.ts      キャラクター選択の状態遷移（純粋関数）
    AchievementsScene.ts 実績画面
    achievementStorage.ts 実績のローカルストレージ永続化（AchievementStore の Layer）
    session.ts          Scene 間で共有する型付きの状態（対戦カード・シード・実績ストア）
    BattleScene.ts      マッチの Fiber を起動し、Effect.async で UI と橋渡し
    ui.ts               対戦画面の描画（サンクの可視化・STW・実績トーストなど）
    widgets.ts          共通部品（ボタン・文字スタイル・キー登録）
    fx.ts               演出部品（背景・フェード・火花・光彩・描画品質の自動調整）
    avatar.ts           キャラ表示（キャラ色のカード＋公式ロゴ。ロゴが無ければ絵文字）
    phaserRandom.ts     Phaser.Math.RND を包む RandomService Layer
    launch.ts           URL クエリのパース
test/                   vitest（定数・シード固定の乱数スタブと台本入力で全スキル・隠れデメリットを検証）
public/logos/           各言語のロゴ（SVG）
```

## キャラクターの追加

1. `balance.ts` の `Balance.characters` と `RAW_BALANCE` に数値を追加
2. `characters.ts` の `rawCharacters` に定義を追加。スキルは `skillId`・`kind`・`condition`（条件の原子の配列）・`activate`（効果）の組み合わせで記述し、
   隠れデメリットがあれば `hiddenTrait` と、`achievements.ts` に対応する実績を追加
3. 新しい種類の条件・効果が必要なら `conditions.ts` / `skills.ts` / `traits.ts` の Union に足す
   （`switch` の網羅性チェックにより、実装漏れはコンパイルエラーになる）

## 実装メモ

- `Effect.assert` は Effect 3 に存在しないため、同等の `assertInvariant`（偽なら `Effect.dieMessage`）を `state.ts` に定義している。
  ターン境界ごとに HP 範囲・手札枚数・used フラグ・捨て札合計（手札＋捨て札＝初期＋生成）・サンク累積ダメージを検証する

## ロゴについて

`public/logos/` の各言語ロゴは [devicon](https://github.com/devicons/devicon)（MIT License, `public/logos/LICENSE-devicon.txt`）の
“original” 版。MIT が適用されるのは devicon の収録物としての部分で、**ロゴそのものは各権利者の商標**。

- Java：Oracle の商標。一般向けに公開する場合は Oracle の商標ガイドラインの確認が必要
- C：公式ロゴは存在しないため、広く使われている非公式ロゴ
- JavaScript：公式ロゴは存在しないため、コミュニティで広く使われている「JS」ロゴ
- Python（PSF）・PHP・C++（Standard C++ Foundation）・Haskell：各団体の利用規約に従う

試験公開の範囲を超えて配布する場合は、各ガイドラインを確認するか、`logoKey` の画像を差し替えること
（`public/logos/<logoKey>.svg` を置き換えるだけで反映される）。
