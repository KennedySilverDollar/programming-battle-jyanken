import { Option } from "effect";
import * as Phaser from "phaser";
import type { Damage, BattleEvent, RoundResult } from "../core/events";
import { availableMoves, type Hand } from "../core/hand";
import { MOVE_LABEL, MOVES, type Move, type Outcome } from "../core/move";
import { opponentOf, type Side } from "../core/side";
import type { BattleView, ChoiceView, OpponentView, OwnView } from "../core/view";
import { createAvatar, type FighterAvatar } from "./avatar";
import { addGlow, type Glow, burst, confetti, createBackdrop, flash, floatText, popIn, punch, shake } from "./fx";
import { createButton, GAME_HEIGHT, GAME_WIDTH, textStyle } from "./widgets";

/** 演出時間（ms）。エンジンは各イベントの演出が終わるまで次へ進まない。 */
export const TIMING = {
  roundIntro: 1200,
  turnIntro: 300,
  skillBanner: 1500,
  reveal: 1500,
  endButtons: 600,
} satisfies Record<string, number>;

const handText = (hand: Hand): string => MOVES.map((m) => `${MOVE_LABEL[m]}${String(hand[m])}`).join("  ");
const discardText = (discard: readonly Move[]): string =>
  discard.length === 0 ? "（なし）" : discard.map((m) => MOVE_LABEL[m]).join(" ");

const OUTCOME_TEXT: Readonly<Record<Outcome, string>> = { Win: "勝ち！", Lose: "負け…", Draw: "あいこ" };
const OUTCOME_COLOR: Readonly<Record<Outcome, string>> = { Win: "#4cd964", Lose: "#ff6b6b", Draw: "#c8d0e0" };

const AVATAR_X: Readonly<Record<Side, number>> = { Player: 320, Cpu: GAME_WIDTH - 320 };
const AVATAR_Y = 270;
const CARD_Y = 620;
/** 左右のアバターに重ならない中央メッセージの最大幅。 */
const MESSAGE_MAX_WIDTH = 400;

const hpColor = (ratio: number): number => (ratio > 0.4 ? 0x4cd964 : ratio > 0.2 ? 0xffcc00 : 0xff3b30);

interface HpBar {
  readonly fill: Phaser.GameObjects.Rectangle;
  /** 遅れて追いかける残像バー（減った量が一瞬見える）。 */
  readonly ghost: Phaser.GameObjects.Rectangle;
  readonly label: Phaser.GameObjects.Text;
  readonly width: number;
  /** 表示中の HP（カウントダウン用）。 */
  shown: number;
}

type CardLook = "focus" | "idle" | "locked" | "empty";

interface HandCard {
  readonly root: Phaser.GameObjects.Container;
  readonly box: Phaser.GameObjects.Rectangle;
  readonly label: Phaser.GameObjects.Text;
  readonly glow: Glow;
  look: CardLook | null;
}

/** オープン時に中央へ出る手のカード。 */
interface RevealCard {
  readonly root: Phaser.GameObjects.Container;
  readonly label: Phaser.GameObjects.Text;
}

interface Banner {
  readonly root: Phaser.GameObjects.Container;
  readonly bg: Phaser.GameObjects.Rectangle;
  readonly stripes: readonly Phaser.GameObjects.Rectangle[];
  readonly title: Phaser.GameObjects.Text;
  readonly body: Phaser.GameObjects.Text;
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
  private readonly colors: Record<Side, number>;
  private readonly skillText: Record<Side, Phaser.GameObjects.Text>;
  private readonly discardLabel: Record<Side, Phaser.GameObjects.Text>;
  private readonly opponentHand: Phaser.GameObjects.Text;
  private readonly turnText: Phaser.GameObjects.Text;
  private readonly message: Phaser.GameObjects.Text;
  private readonly banner: Banner;
  private readonly cards: Record<Move, HandCard>;
  private readonly reveal: Record<Side, RevealCard>;
  private readonly hint: Phaser.GameObjects.Text;
  /** 試合終了後に手札カードの位置へ出すボタン。 */
  private readonly endButtons: readonly Phaser.GameObjects.Container[];
  private selection: Selection | null = null;
  private ended = false;

  constructor(
    private readonly scene: Phaser.Scene,
    view: BattleView,
    handlers: UiHandlers,
  ) {
    const { self, opponent } = view;
    this.colors = { Player: self.character.placeholder.color, Cpu: opponent.character.placeholder.color };
    createBackdrop(scene, [this.colors.Player, this.colors.Cpu]);

    this.turnText = scene.add.text(GAME_WIDTH / 2, 40, "", textStyle(24)).setOrigin(0.5);
    this.hp = {
      Player: this.makeHpBar(40, 30, self.character.name, self.character.maxHp),
      Cpu: this.makeHpBar(GAME_WIDTH - 40 - 480, 30, `${opponent.character.name} (CPU)`, opponent.character.maxHp),
    };
    this.avatars = {
      Player: createAvatar(scene, self.character, AVATAR_X.Player, AVATAR_Y, 1),
      Cpu: createAvatar(scene, opponent.character, AVATAR_X.Cpu, AVATAR_Y, -1),
    };
    this.skillText = {
      Player: scene.add.text(AVATAR_X.Player, 405, "", textStyle(18, "#c8d0e0")).setOrigin(0.5),
      Cpu: scene.add.text(AVATAR_X.Cpu, 405, "", textStyle(18, "#c8d0e0")).setOrigin(0.5),
    };
    this.discardLabel = {
      Player: scene.add.text(80, 440, "", textStyle(20)).setWordWrapWidth(480),
      Cpu: scene.add.text(GAME_WIDTH - 560, 440, "", textStyle(20)).setWordWrapWidth(480),
    };
    this.opponentHand = scene.add.text(GAME_WIDTH - 560, 500, "", textStyle(22, "#ffd866"));
    this.message = scene.add
      .text(GAME_WIDTH / 2, AVATAR_Y, "", { ...textStyle(30), align: "center", fontStyle: "bold" })
      .setOrigin(0.5)
      .setStroke("#000000", 6)
      .setDepth(30);
    this.reveal = { Player: this.makeRevealCard(), Cpu: this.makeRevealCard() };

    this.cards = {
      Slash: this.makeCard("Slash", GAME_WIDTH / 2 - 170),
      Guard: this.makeCard("Guard", GAME_WIDTH / 2),
      Step: this.makeCard("Step", GAME_WIDTH / 2 + 170),
    };
    this.endButtons = [
      createButton(scene, GAME_WIDTH / 2 - 140, CARD_Y, "リスタート (R)", handlers.onRestart, 250),
      createButton(scene, GAME_WIDTH / 2 + 140, CARD_Y, "キャラ選択へ (C)", handlers.onBackToSelect, 250),
    ];
    for (const b of this.endButtons) b.setVisible(false);
    this.hint = scene.add.text(GAME_WIDTH / 2, 700, "", textStyle(18, "#9aa4b8")).setOrigin(0.5);
    this.banner = this.makeBanner();

    this.render(view, Option.none());
  }

  // -------------------------------------------------------------------------
  // 部品
  // -------------------------------------------------------------------------

  private makeHpBar(x: number, y: number, name: string, maxHp: number): HpBar {
    const width = 480;
    this.scene.add.text(x, y, name, textStyle(22));
    this.scene.add.rectangle(x, y + 34, width, 22, 0x2a2f3a).setOrigin(0, 0);
    const ghost = this.scene.add.rectangle(x, y + 34, width, 22, 0xffffff, 0.85).setOrigin(0, 0);
    const fill = this.scene.add.rectangle(x, y + 34, width, 22, 0x4cd964).setOrigin(0, 0);
    // 上半分のハイライト
    this.scene.add.rectangle(x, y + 34, width, 8, 0xffffff, 0.12).setOrigin(0, 0);
    const label = this.scene.add.text(x + width, y, "", textStyle(22)).setOrigin(1, 0);
    return { fill, ghost, label, width, shown: maxHp };
  }

  /** 手札カード。ホバーで持ち上がって光り、クリックで決定（キーボードの A/D・J と同じ動作）。 */
  private makeCard(move: Move, x: number): HandCard {
    const box = this.scene.add
      .rectangle(0, 0, 140, 100, 0x2a2f3a)
      .setStrokeStyle(3, 0x596275)
      .setInteractive({ useHandCursor: true });
    box.on(Phaser.Input.Events.GAMEOBJECT_POINTER_OVER, () => {
      this.focus(move);
    });
    box.on(Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN, () => {
      this.pick(move);
    });
    const label = this.scene.add.text(0, 0, "", { ...textStyle(30), align: "center" }).setOrigin(0.5);
    const root = this.scene.add.container(x, CARD_Y, [box, label]);
    return { root, box, label, glow: addGlow(this.scene, root, 140, 100, 0xffd866), look: null };
  }

  private makeRevealCard(): RevealCard {
    const box = this.scene.add.rectangle(0, 0, 120, 150, 0x1b1f2a).setStrokeStyle(4, 0xffffff, 0.9);
    const label = this.scene.add.text(0, 0, "", { ...textStyle(64), fontStyle: "bold" }).setOrigin(0.5);
    const root = this.scene.add
      .container(GAME_WIDTH / 2, AVATAR_Y - 30, [box, label])
      .setDepth(20)
      .setVisible(false);
    return { root, label };
  }

  private makeBanner(): Banner {
    const cy = GAME_HEIGHT / 2;
    const bg = this.scene.add.rectangle(0, 0, GAME_WIDTH, 170, 0x05070b, 0.86);
    const stripes = [
      this.scene.add.rectangle(0, -85, GAME_WIDTH, 4, 0xffd866),
      this.scene.add.rectangle(0, 85, GAME_WIDTH, 4, 0xffd866),
    ];
    const title = this.scene.add.text(0, -30, "", { ...textStyle(44, "#ffd866"), fontStyle: "bold" }).setOrigin(0.5);
    const body = this.scene.add.text(0, 35, "", textStyle(22)).setOrigin(0.5);
    const root = this.scene.add
      .container(GAME_WIDTH / 2, cy, [bg, ...stripes, title, body])
      .setDepth(60)
      .setVisible(false);
    return { root, bg, stripes, title, body };
  }

  // -------------------------------------------------------------------------
  // 描画
  // -------------------------------------------------------------------------

  /** HP バー：本体はすぐ、残像は少し遅れて追いかけ、数値はカウントダウンする。 */
  private renderHp(side: Side, hp: number, maxHp: number): void {
    const bar = this.hp[side];
    const ratio = Phaser.Math.Clamp(hp / maxHp, 0, 1);
    const target = bar.width * ratio;
    bar.fill.fillColor = hpColor(ratio);
    if (bar.shown === hp) {
      bar.fill.width = target;
      bar.ghost.width = target;
      bar.label.setText(`${String(hp)} / ${String(maxHp)}`);
      return;
    }
    this.scene.tweens.add({ targets: bar.fill, width: target, duration: 220, ease: "Cubic.easeOut" });
    this.scene.tweens.add({ targets: bar.ghost, width: target, duration: 520, delay: 380, ease: "Cubic.easeIn" });
    this.scene.tweens.addCounter({
      from: bar.shown,
      to: hp,
      duration: 420,
      onUpdate: (tween) => {
        bar.label.setText(`${String(Math.round(tween.getValue() ?? hp))} / ${String(maxHp)}`);
      },
    });
    bar.shown = hp;
  }

  private renderSkill(side: Side, v: OwnView | OpponentView): void {
    this.skillText[side].setText(`スキル「${v.skill.name}」${v.skill.used ? "（使用済み）" : ""}`);
  }

  private setCardLook(card: HandCard, look: CardLook): void {
    if (card.look === look) return;
    card.look = look;
    const lifted = look === "focus";
    this.scene.tweens.add({
      targets: card.root,
      y: lifted ? CARD_Y - 14 : CARD_Y,
      scale: lifted ? 1.07 : 1,
      alpha: look === "empty" ? 0.35 : look === "locked" ? 0.6 : 1,
      duration: 140,
      ease: "Quad.easeOut",
    });
    card.box.setStrokeStyle(lifted ? 5 : 3, lifted ? 0xffd866 : 0x596275);
    card.box.setFillStyle(lifted ? 0x3b4252 : 0x2a2f3a);
    card.glow.set(lifted);
  }

  private renderOwnHand(self: OwnView): void {
    const sel = this.selection;
    for (const m of MOVES) {
      const card = this.cards[m];
      const count = self.hand[m];
      card.label.setText(`${MOVE_LABEL[m]}\n×${String(count)}`);
      const look: CardLook = count === 0 ? "empty" : sel === null ? "locked" : sel.cursor === m ? "focus" : "idle";
      this.setCardLook(card, look);
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

  /** withHp = false のときは HP バーを据え置く（オープン演出で命中に合わせて減らすため）。 */
  render(view: BattleView, opponentTotal: Option.Option<number>, withHp = true): void {
    const { self, opponent } = view;
    if (!this.ended) this.turnText.setText(`Turn ${String(view.turn)}`);
    if (withHp) this.renderHps(view);
    this.renderSkill("Player", self);
    this.renderSkill("Cpu", opponent);
    this.discardLabel.Player.setText(`自分の捨て札: ${discardText(self.discard)}`);
    this.discardLabel.Cpu.setText(`相手の捨て札: ${discardText(opponent.discard)}`);
    if (!this.ended) this.renderOwnHand(self);
    this.renderOpponentHand(opponent, opponentTotal);
    this.avatars.Player.setActive(this.selection !== null);
  }

  private renderHps(view: BattleView): void {
    this.renderHp("Player", view.self.hp, view.self.character.maxHp);
    this.renderHp("Cpu", view.opponent.hp, view.opponent.character.maxHp);
  }

  private showBanner(title: string, body: string, color: number, ms: number): void {
    const b = this.banner;
    b.title.setText(title);
    b.body.setText(body);
    for (const s of b.stripes) s.setFillStyle(color);
    b.root.setVisible(true).setAlpha(1);
    b.bg.setScale(1, 0);
    b.title.setX(-80).setAlpha(0);
    b.body.setAlpha(0);
    for (const s of b.stripes) s.setScale(0, 1);
    this.scene.tweens.add({ targets: b.bg, scaleY: 1, duration: 180, ease: "Cubic.easeOut" });
    this.scene.tweens.add({ targets: b.stripes, scaleX: 1, duration: 320, ease: "Cubic.easeOut" });
    this.scene.tweens.add({ targets: b.title, x: 0, alpha: 1, duration: 300, delay: 100, ease: "Back.easeOut" });
    this.scene.tweens.add({ targets: b.body, alpha: 1, duration: 260, delay: 220 });
    this.scene.tweens.add({ targets: b.root, alpha: 0, duration: 200, delay: ms - 220 });
    this.scene.time.delayedCall(ms, () => b.root.setVisible(false));
  }

  /** 中央のメッセージを 2 体のアバターの間（約 400px）に収まるよう縮める。 */
  private fitMessage(): void {
    this.message.setScale(1);
    this.message.setScale(Math.min(1, MESSAGE_MAX_WIDTH / this.message.width));
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
  // 演出
  // -------------------------------------------------------------------------

  private playIntro(view: BattleView): void {
    this.avatars.Player.enter(0);
    this.avatars.Cpu.enter(80);
    this.message.setFontSize(48).setText(`${view.self.character.name}  VS  ${view.opponent.character.name}`);
    this.fitMessage();
    popIn(this.scene, this.message, 380, 1.8);
    this.scene.time.delayedCall(560, () => {
      flash(this.scene, 0xffffff, 140);
      burst(this.scene, GAME_WIDTH / 2, AVATAR_Y, [this.colors.Player, this.colors.Cpu, 0xffffff], 30);
      this.avatars.Player.startIdle();
      this.avatars.Cpu.startIdle();
    });
    this.scene.tweens.add({ targets: this.message, alpha: 0, duration: 200, delay: TIMING.roundIntro - 220 });
  }

  /** 両者のカードをめくって中央でぶつけ、命中に合わせて HP を減らす。 */
  private playReveal(
    view: BattleView,
    moves: Readonly<Record<Side, Move>>,
    outcome: Outcome,
    damage: Damage | null,
  ): void {
    const { scene } = this;
    const winner: Side | null = damage === null ? null : opponentOf(damage.target);
    const startX: Record<Side, number> = { Player: GAME_WIDTH / 2 - 110, Cpu: GAME_WIDTH / 2 + 110 };
    const clashX: Record<Side, number> = { Player: GAME_WIDTH / 2 - 62, Cpu: GAME_WIDTH / 2 + 62 };

    for (const side of ["Player", "Cpu"] satisfies Side[]) {
      const card = this.reveal[side];
      card.label.setText(MOVE_LABEL[moves[side]]);
      card.root
        .setVisible(true)
        .setPosition(AVATAR_X[side], AVATAR_Y - 30)
        .setScale(0, 1)
        .setAlpha(1)
        .setAngle(0);
      // めくり（横幅 0 → 1）
      scene.tweens.add({
        targets: card.root,
        x: startX[side],
        scaleX: 1,
        duration: 240,
        ease: "Back.easeOut",
      });
      // ぶつかる
      scene.tweens.add({ targets: card.root, x: clashX[side], duration: 110, delay: 320, ease: "Quad.easeIn" });
    }
    if (winner !== null)
      scene.time.delayedCall(300, () => {
        this.avatars[winner].lunge();
      });

    scene.time.delayedCall(430, () => {
      const colors = winner === null ? [0xffffff, 0xc8d0e0] : [this.colors[winner], 0xffd866, 0xffffff];
      burst(scene, GAME_WIDTH / 2, AVATAR_Y - 30, colors, winner === null ? 18 : 34);
      if (winner === null || damage === null) {
        shake(scene, 0.004, 140);
        // あいこ：両者はじかれる
        for (const side of ["Player", "Cpu"] satisfies Side[]) {
          scene.tweens.add({ targets: this.reveal[side].root, x: startX[side], duration: 220, ease: "Back.easeOut" });
        }
      } else {
        const loser = damage.target;
        flash(scene, 0xffffff, 90);
        shake(scene, damage.amount >= 30 ? 0.016 : 0.009, 240);
        this.avatars[loser].hit();
        floatText(
          scene,
          AVATAR_X[loser],
          AVATAR_Y - 150,
          `-${String(damage.amount)}`,
          "#ff6b6b",
          damage.amount >= 30 ? 60 : 46,
        );
        punch(scene, this.reveal[winner].root, 1.25, 140);
        scene.tweens.add({
          targets: this.reveal[loser].root,
          angle: loser === "Player" ? -35 : 35,
          y: AVATAR_Y + 40,
          alpha: 0,
          scale: 0.6,
          duration: 380,
          ease: "Cubic.easeIn",
        });
      }
      this.renderHps(view);
      this.message
        .setScale(1)
        .setFontSize(34)
        .setColor(OUTCOME_COLOR[outcome])
        .setText(OUTCOME_TEXT[outcome])
        .setY(AVATAR_Y + 110);
      popIn(scene, this.message, 0, 0.5);
    });

    // 片付け
    scene.tweens.add({
      targets: [this.reveal.Player.root, this.reveal.Cpu.root, this.message],
      alpha: 0,
      duration: 220,
      delay: TIMING.reveal - 240,
    });
  }

  private playSkill(side: Side, title: string, body: string): void {
    const color = this.colors[side];
    this.avatars[side].pulse(color, 1200);
    burst(this.scene, AVATAR_X[side], AVATAR_Y, [color, 0xffffff], 28);
    this.showBanner(title, body, color, TIMING.skillBanner);
  }

  private playEnding(view: BattleView, result: RoundResult): void {
    this.ended = true;
    this.turnText.setText("試合終了");
    for (const card of Object.values(this.cards)) {
      this.scene.tweens.add({ targets: card.root, alpha: 0, y: CARD_Y + 30, duration: 200 });
    }
    this.message.setFontSize(60).setColor("#ffffff").setY(AVATAR_Y).setText(this.resultText(view, result));
    this.fitMessage();
    popIn(this.scene, this.message, 120, 2);
    this.message.setShadow(0, 0, "#ffd866", 18, true, true);
    switch (result._tag) {
      case "Victory": {
        const loser = opponentOf(result.winner);
        this.avatars[result.winner].celebrate();
        this.avatars[loser].defeat();
        confetti(this.scene, AVATAR_X[result.winner], [this.colors[result.winner], 0xffd866, 0xffffff, 0x7fdbff]);
        break;
      }
      case "Draw":
        this.avatars.Player.pulse(0xffffff, 1200);
        this.avatars.Cpu.pulse(0xffffff, 1200);
        break;
    }
    // 手札を連打していた指で誤って押さないよう、少し遅らせて出す
    this.scene.time.delayedCall(TIMING.endButtons, () => {
      this.endButtons.forEach((b, i) => {
        b.setVisible(true);
        popIn(this.scene, b, i * 80, 0.7);
      });
    });
  }

  // -------------------------------------------------------------------------
  // エンジンからの要求
  // -------------------------------------------------------------------------

  /** イベントを表示し、演出が終わったら done を呼ぶ。返り値はキャンセル関数。 */
  present(event: BattleEvent, done: () => void): () => void {
    // オープン時の HP は命中の瞬間に減らす
    this.render(event.view, Option.none(), event._tag !== "MovesRevealed");
    const after = (ms: number): (() => void) => {
      const timer = this.scene.time.delayedCall(ms, done);
      return () => {
        timer.remove(false);
      };
    };
    switch (event._tag) {
      case "RoundStarted":
        this.playIntro(event.view);
        return after(TIMING.roundIntro);
      case "TurnStarted":
        punch(this.scene, this.turnText, 1.3, 140);
        return after(TIMING.turnIntro);
      case "SkillActivated":
        this.playSkill(event.side, `${this.sideName(event.view, event.side)}：${event.name}`, event.description);
        return after(TIMING.skillBanner);
      case "SkillNegated":
        this.avatars[event.target].pulse(0x888888, 1200);
        this.playSkill(
          event.by,
          `${this.sideName(event.view, event.by)}：${event.byName}`,
          `${this.sideName(event.view, event.target)} の「${event.targetName}」を無効化した！`,
        );
        return after(TIMING.skillBanner);
      case "MovesRevealed":
        this.playReveal(event.view, event.moves, event.outcome, event.damage);
        return after(TIMING.reveal);
      case "RoundEnded":
        this.playEnding(event.view, event.result);
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
    const card = this.cards[sel.cursor].root;
    burst(this.scene, card.x, card.y, [0xffd866, 0xffffff], 14);
    this.endSelection(sel.view);
    sel.onDecide(sel.cursor);
  }

  showFatal(text: string): void {
    this.showBanner("内部エラー", text.slice(0, 120), 0xff3b30, 60_000);
  }
}
