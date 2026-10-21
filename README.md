# programming-battle-jyanken

プログラミング言語どうしが戦う、じゃんけん式 1 対 1 チャンバラゲーム（Phaser 4 + TypeScript + Vite + Effect）。

> 現在は **骨格段階**：キャラ定義・判定テーブル・スキル・矩形表示・1 試合の戦闘ループのみ。
> ベストオブ 3、UI 強化、エフェクトはこの後に段階的に追加する。

## 実行

```sh
npm install
npm run dev        # http://localhost:5173/
npm run check      # typecheck + lint + test
npm run build
```

URL クエリでキャラとシードを指定できる：`/?player=python&cpu=haskell&seed=42`
（キャラ ID: `python` / `javascript` / `cpp` / `haskell`。seed 省略時は時刻から決定）

操作：**A / D** で手を選ぶ、**J** で決定、試合終了後に **R** でリスタート。

## 構成

```
src/
  core/                 Phaser に依存しないゲームロジック（すべて Effect）
    move.ts             Move（Slash/Guard/Step）と判定テーブル Record<Move, Record<Move, Outcome>>
    balance.ts          バランス値（HP・カード枚数・ダメージ・スキル閾値）の Schema と生データ
    characters.ts       CharacterDef の Schema とキャラデータ
    skills.ts           SkillSpec（データ）の Schema と Skill インターフェース・実装
    state.ts            GameState / FighterState と不変条件チェック
    battle.ts           ターン進行（スキル判定→手選択→オープン→ダメージ→勝敗判定）
    view.ts             視点ごとの View（相手の手札内訳は型レベルで隔離）
    events.ts           エンジン → ホストのイベント、試合結果
    services.ts         PlayerInput / CpuStrategy / BattleEvents サービス
    random.ts           RandomService とシード固定スタブ
    ai.ts               CPU（骨格用ランダム）
    gameData.ts         起動時パース
    errors.ts           型付きエラー
  game/                 Phaser ホスト（薄い）
    BattleScene.ts      Fiber を起動し、Effect.async でUIと橋渡し
    ui.ts               描画
    avatar.ts           キャラ表示（矩形 → logoKey の画像があれば自動差し替え）
    phaserRandom.ts     Phaser.Math.RND を包む RandomService Layer
    launch.ts           URL クエリのパース
test/                   vitest（シード固定スタブ・スクリプト入力で戦闘を検証）
```

## キャラクターの追加

1. `balance.ts` の `Balance.characters` と `RAW_BALANCE` に数値を追加
2. `characters.ts` の `rawCharacters` に定義を追加（スキルは `SkillSpec` の組み合わせで記述）
3. 新しい種類の発動条件・効果が必要なら `skills.ts` の `SkillTrigger` / `SkillEffect` に足す
   （`switch` の網羅性チェックにより、実装漏れはコンパイルエラーになる）

## ルール上の補足（仕様にない部分の決定）

- **両者同時に手札 0**：全キャラ 12 枚で毎ターン 1 枚ずつ消費するため、HP で決着しなければ必ず同時に手札切れになる。
  この場合は **HP 割合（HP / 最大 HP）が高い方の勝ち**、同率なら引き分けとした。
- **Haskell vs Haskell**：「純粋関数」の条件は「相手の *Active* スキルが条件を満たした」なので、互いに発動しない。
- **UB 同士**：倍率は勝者・敗者の両方に掛かる（両者 UB なら 4 倍）。
- `Effect.assert` は Effect 3 に存在しないため、同等の `assertInvariant`（偽なら `Effect.dieMessage`）を `state.ts` に定義している。
