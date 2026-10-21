import { Option } from "effect";
import * as Phaser from "phaser";
import type { BattleEvent, RoundResult } from "../core/events";
import { availableMoves, type Hand } from "../core/hand";
import { MOVE_LABEL, MOVES, type Move, type Outcome } from "../core/move";
import type { Side } from "../core/side";
import type { BattleView, ChoiceView, OpponentView, OwnView } from "../core/view";
import { createAvatar, type FighterAvatar } from "./avatar";
import { createButton, GAME_HEIGHT, GAME_WIDTH, textStyle } from "./widgets";

/** 演出時間（ms）。 */
export const TIMING = {
  roundIntro: 800,
  turnIntro: 250,
  skillBanner: 1500,
  reveal: 1300,
  endButtons: 600,
} satisfies Record<string, number>;

const handText = (hand: Hand): string => MOVES.map((m) => `${MOVE_LABEL[m]}${String(hand[m])}`).join("  ");
const discardText = (discard: readonly Move[]): string =>
  discard.length === 0 ? "（なし）" : discard.map((m) => MOVE_LABEL[m]).join(" ");

const OUTCOME_TEXT: Readonly<Record<Outcome, string>> = { Win: "勝ち！", Lose: "負け…", Draw: "あいこ" };

interface HpBar {
  readonly fill: Phaser.GameObjects.Rectangle;
  readonly label: Phaser.GameObjects.Text;
  readonly width: number;
}

/** UI から Scene へ返す操作要求。 */
export interface UiHandlers {
  readonly onRestart: () => void;
  readonly onBackToSelect: () => void;
}

interface Selection {
  readonly view: ChoiceView;
  readonly onDecide: (move: Move) => void;
  cursor: Move;
}

/**
 * 表示専用。ゲーム状態は持たず、エンジンから届く View をそのまま描く。
 * 相手情報は OpponentView（手札内訳は Python 発動後のみ Some）と、
 * 手選択中に限り ChoiceView.opponentHandTotal しか受け取らない。
 */
export class BattleUi {
  private readonly hp: Record<Side, HpBar>;
  private readonly avatars: Record<Side, FighterAvatar>;
  private readonly skillText: Record<Side, Phaser.GameObjects.Text>;
  private readonly discardLabel: Record<Side, Phaser.GameObjects.Text>;
  private readonly opponentHand: Phaser.GameObjects.Text;
  private readonly turnText: Phaser.GameObjects.Text;
  private readonly message: Phaser.GameObjects.Text;
  private readonly bannerBg: Phaser.GameObjects.Rectangle;
  private readonly bannerTitle: Phaser.GameObjects.Text;
  private readonly bannerBody: Phaser.GameObjects.Text;
  private readonly cards: Record<Move, { box: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text }>;
  private readonly hint: Phaser.GameObjects.Text;
  /** 試合終了後に手札カードの位置へ出すボタン。 */
  private readonly endButtons: readonly Phaser.GameObjects.Container[];
  private selection: Selection | null = null;

  constructor(
    private readonly scene: Phaser.Scene,
    view: BattleView,
    handlers: UiHandlers,
  ) {
    const { self, opponent } = view;
    this.turnText = scene.add.text(GAME_WIDTH / 2, 40, "", textStyle(24)).setOrigin(0.5);
    this.hp = {
      Player: this.makeHpBar(40, 30, self.character.name),
      Cpu: this.makeHpBar(GAME_WIDTH - 40 - 480, 30, `${opponent.character.name} (CPU)`),
    };
    this.avatars = {
      Player: createAvatar(scene, self.character, 320, 270),
      Cpu: createAvatar(scene, opponent.character, GAME_WIDTH - 320, 270),
    };
    this.skillText = {
      Player: scene.add.text(320, 405, "", textStyle(18, "#c8d0e0")).setOrigin(0.5),
      Cpu: scene.add.text(GAME_WIDTH - 320, 405, "", textStyle(18, "#c8d0e0")).setOrigin(0.5),
    };
    this.discardLabel = {
      Player: scene.add.text(80, 440, "", textStyle(20)).setWordWrapWidth(480),
      Cpu: scene.add.text(GAME_WIDTH - 560, 440, "", textStyle(20)).setWordWrapWidth(480),
    };
    this.opponentHand = scene.add.text(GAME_WIDTH - 560, 500, "", textStyle(22, "#ffd866"));
    this.message = scene.add.text(GAME_WIDTH / 2, 270, "", { ...textStyle(30), align: "center" }).setOrigin(0.5);

    this.cards = {
      Slash: this.makeCard("Slash", GAME_WIDTH / 2 - 170),
      Guard: this.makeCard("Guard", GAME_WIDTH / 2),
      Step: this.makeCard("Step", GAME_WIDTH / 2 + 170),
    };
    this.endButtons = [
      createButton(scene, GAME_WIDTH / 2 - 140, 620, "リスタート (R)", handlers.onRestart, 250),
      createButton(scene, GAME_WIDTH / 2 + 140, 620, "キャラ選択へ (C)", handlers.onBackToSelect, 250),
    ];
    for (const b of this.endButtons) b.setVisible(false);
    this.hint = scene.add.text(GAME_WIDTH / 2, 700, "", textStyle(18, "#9aa4b8")).setOrigin(0.5);

    this.bannerBg = scene.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, 170, 0x000000, 0.8);
    this.bannerTitle = scene.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 30, "", textStyle(44, "#ffd866"))
      .setOrigin(0.5);
    this.bannerBody = scene.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 35, "", textStyle(22)).setOrigin(0.5);
    this.setBanner(null);

    this.render(view, Option.none());
  }

  // -------------------------------------------------------------------------
  // 描画
  // -------------------------------------------------------------------------

  private makeHpBar(x: number, y: number, name: string): HpBar {
    const width = 480;
    this.scene.add.text(x, y, name, textStyle(22));
    this.scene.add.rectangle(x, y + 34, width, 22, 0x2a2f3a).setOrigin(0, 0);
    const fill = this.scene.add.rectangle(x, y + 34, width, 22, 0x4cd964).setOrigin(0, 0);
    const label = this.scene.add.text(x + width, y, "", textStyle(22)).setOrigin(1, 0);
    return { fill, label, width };
  }

  /** 手札カード。ホバーで選択、クリックで決定（キーボードの A/D・J と同じ動作）。 */
  private makeCard(move: Move, x: number): { box: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text } {
    const box = this.scene.add
      .rectangle(x, 620, 140, 100, 0x2a2f3a)
      .setStrokeStyle(3, 0x596275)
      .setInteractive({ useHandCursor: true });
    box.on(Phaser.Input.Events.GAMEOBJECT_POINTER_OVER, () => {
      this.focus(move);
    });
    box.on(Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN, () => {
      this.pick(move);
    });
    const label = this.scene.add.text(x, 620, "", { ...textStyle(30), align: "center" }).setOrigin(0.5);
    return { box, label };
  }

  private renderHp(side: Side, hp: number, maxHp: number): void {
    const bar = this.hp[side];
    const ratio = Phaser.Math.Clamp(hp / maxHp, 0, 1);
    bar.fill.width = bar.width * ratio;
    bar.fill.fillColor = ratio > 0.4 ? 0x4cd964 : ratio > 0.2 ? 0xffcc00 : 0xff3b30;
    bar.label.setText(`${String(hp)} / ${String(maxHp)}`);
  }

  private renderSkill(side: Side, v: OwnView | OpponentView): void {
    this.skillText[side].setText(`スキル「${v.skill.name}」${v.skill.used ? "（使用済み）" : ""}`);
  }

  private renderOwnHand(self: OwnView): void {
    const sel = this.selection;
    for (const m of MOVES) {
      const { box, label } = this.cards[m];
      const count = self.hand[m];
      const focused = sel !== null && sel.cursor === m;
      label.setText(`${MOVE_LABEL[m]}\n×${String(count)}`);
      label.setAlpha(count > 0 ? 1 : 0.35);
      box.setStrokeStyle(focused ? 5 : 3, focused ? 0xffd866 : 0x596275);
      box.setFillStyle(focused ? 0x3b4252 : 0x2a2f3a);
    }
    this.hint.setText(sel === null ? "" : "クリックで決定    ／    A / D : 手を選ぶ    J : 決定");
  }

  /**
   * 相手の手札表示。
   * - Python 発動後（revealedHand が Some）：内訳を常に表示
   * - 手選択中：合計枚数のみ
   * - それ以外：何も表示しない
   */
  private renderOpponentHand(opponent: OpponentView, total: Option.Option<number>): void {
    const text = Option.match(opponent.revealedHand, {
      onSome: (hand) => `相手の手札: ${handText(hand)}`,
      onNone: () =>
        Option.match(total, {
          onSome: (n) => `相手の手札: 残り ${String(n)} 枚`,
          onNone: () => "",
        }),
    });
    this.opponentHand.setText(text);
  }

  render(view: BattleView, opponentTotal: Option.Option<number>): void {
    const { self, opponent } = view;
    this.turnText.setText(`Turn ${String(view.turn)}`);
    this.renderHp("Player", self.hp, self.character.maxHp);
    this.renderHp("Cpu", opponent.hp, opponent.character.maxHp);
    this.renderSkill("Player", self);
    this.renderSkill("Cpu", opponent);
    this.discardLabel.Player.setText(`自分の捨て札: ${discardText(self.discard)}`);
    this.discardLabel.Cpu.setText(`相手の捨て札: ${discardText(opponent.discard)}`);
    this.renderOwnHand(self);
    this.renderOpponentHand(opponent, opponentTotal);
    this.avatars.Player.setActive(this.selection !== null);
  }

  private setBanner(content: { title: string; body: string } | null): void {
    const visible = content !== null;
    this.bannerBg.setVisible(visible);
    this.bannerTitle.setVisible(visible).setText(content?.title ?? "");
    this.bannerBody.setVisible(visible).setText(content?.body ?? "");
  }

  private sideName(view: BattleView, side: Side): string {
    switch (side) {
      case "Player":
        return view.self.character.name;
      case "Cpu":
        return view.opponent.character.name;
    }
  }

  // -------------------------------------------------------------------------
  // エンジンからの要求
  // -------------------------------------------------------------------------

  /** イベントを表示し、演出が終わったら done を呼ぶ。返り値はキャンセル関数。 */
  present(event: BattleEvent, done: () => void): () => void {
    this.render(event.view, Option.none());
    const after = (ms: number, f?: () => void): (() => void) => {
      const timer = this.scene.time.delayedCall(ms, () => {
        f?.();
        done();
      });
      return () => {
        timer.remove(false);
      };
    };
    switch (event._tag) {
      case "RoundStarted":
        this.message.setText(`${event.view.self.character.name}  VS  ${event.view.opponent.character.name}`);
        return after(TIMING.roundIntro, () => this.message.setText(""));
      case "TurnStarted":
        return after(TIMING.turnIntro);
      case "SkillActivated":
        this.setBanner({
          title: `${this.sideName(event.view, event.side)}：${event.name}`,
          body: event.description,
        });
        return after(TIMING.skillBanner, () => {
          this.setBanner(null);
        });
      case "SkillNegated":
        this.setBanner({
          title: `${this.sideName(event.view, event.by)}：${event.byName}`,
          body: `${this.sideName(event.view, event.target)} の「${event.targetName}」を無効化した！`,
        });
        return after(TIMING.skillBanner, () => {
          this.setBanner(null);
        });
      case "MovesRevealed": {
        const dmg =
          event.damage === null
            ? ""
            : `\n${this.sideName(event.view, event.damage.target)} に ${String(event.damage.amount)} ダメージ`;
        this.message.setText(
          `${MOVE_LABEL[event.moves.Player]}  vs  ${MOVE_LABEL[event.moves.Cpu]}\n${OUTCOME_TEXT[event.outcome]}${dmg}`,
        );
        return after(TIMING.reveal, () => this.message.setText(""));
      }
      case "RoundEnded":
        this.turnText.setText("試合終了");
        this.message.setText(this.resultText(event.view, event.result));
        for (const { box, label } of Object.values(this.cards)) {
          box.setVisible(false);
          label.setVisible(false);
        }
        // 手札を連打していた指で誤って押さないよう、少し遅らせて出す
        this.scene.time.delayedCall(TIMING.endButtons, () => {
          for (const b of this.endButtons) b.setVisible(true);
        });
        return after(0);
    }
  }

  private resultText(view: BattleView, result: RoundResult): string {
    switch (result._tag) {
      case "Victory":
        return `${this.sideName(view, result.winner)} Wins!`;
      case "Draw":
        return "Draw";
    }
  }

  /** 手選択を開始。J で決定すると onDecide を一度だけ呼び、以後オープンまで入力不可。 */
  beginSelection(view: ChoiceView, onDecide: (move: Move) => void): () => void {
    const first = availableMoves(view.self.hand)[0] ?? "Slash";
    this.selection = { view, onDecide, cursor: first };
    this.render(view, Option.some(view.opponentHandTotal));
    return () => {
      this.endSelection(view);
    };
  }

  private endSelection(view: BattleView): void {
    this.selection = null;
    this.render(view, Option.none());
  }

  moveCursor(delta: 1 | -1): void {
    const sel = this.selection;
    if (sel === null) return;
    const moves = availableMoves(sel.view.self.hand);
    const i = moves.indexOf(sel.cursor);
    const next = moves[(i + delta + moves.length) % moves.length];
    if (next === undefined) return;
    sel.cursor = next;
    this.render(sel.view, Option.some(sel.view.opponentHandTotal));
  }

  /** 指定の手にカーソルを合わせる（手札に無い手は無視）。 */
  focus(move: Move): void {
    const sel = this.selection;
    if (sel === null || sel.view.self.hand[move] === 0 || sel.cursor === move) return;
    sel.cursor = move;
    this.render(sel.view, Option.some(sel.view.opponentHandTotal));
  }

  /** 指定の手で即決定する（クリック操作）。 */
  pick(move: Move): void {
    const sel = this.selection;
    if (sel === null || sel.view.self.hand[move] === 0) return;
    sel.cursor = move;
    this.confirm();
  }

  confirm(): void {
    const sel = this.selection;
    if (sel === null) return;
    this.endSelection(sel.view);
    sel.onDecide(sel.cursor);
  }

  showFatal(text: string): void {
    this.setBanner({ title: "内部エラー", body: text.slice(0, 120) });
  }
}
