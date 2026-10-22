import { Option } from "effect";
import * as Phaser from "phaser";
import type { BattleEvent, EffectiveMove, RevealedPlay, RoundResult, TurnNote } from "../core/events";
import type { Hand } from "../core/hand";
import { MOVE_HAND, MOVE_LABEL, MOVE_NAME, MOVES, type Move, type Outcome } from "../core/move";
import { opponentOf, SIDES, type Side } from "../core/side";
import type { TraitId } from "../core/traits";
import type { BattleView, ChoiceView, ExtraChoiceView, OpponentView, OwnView, ThunkView } from "../core/view";
import { createAvatar, type FighterAvatar } from "./avatar";
import { addGlow, burst, confetti, createBackdrop, flash, floatText, type Glow, popIn, punch, shake } from "./fx";
import { createButton, GAME_HEIGHT, GAME_WIDTH, textStyle } from "./widgets";

/** 演出時間（ms）。エンジンは各イベントの演出が終わるまで次へ進まない。 */
export const TIMING = {
  roundIntro: 1200,
  roundStart: 1000,
  turnIntro: 300,
  skillBanner: 1500,
  /** 何度も発動するスキル（GC）の 2 回目以降。 */
  skillBannerRepeat: 900,
  stopTheWorld: 1300,
  trait: 1300,
  reveal: 600,
  extraMove: 600,
  resolve: 1100,
  thunksForced: 1400,
  turnNotes: 700,
  roundEnd: 1800,
  endButtons: 600,
} satisfies Record<string, number>;

const handText = (hand: Hand): string => MOVES.map((m) => `${MOVE_LABEL[m]}${String(hand[m])}`).join("  ");
const discardText = (discard: readonly Move[]): string =>
  discard.length === 0 ? "（なし）" : discard.map((m) => MOVE_LABEL[m]).join(" ");

const OUTCOME_TEXT: Readonly<Record<Outcome, string>> = { Win: "勝ち！", Lose: "負け…", Draw: "あいこ" };
const OUTCOME_COLOR: Readonly<Record<Outcome, string>> = { Win: "#4cd964", Lose: "#ff6b6b", Draw: "#c8d0e0" };

/** 隠れデメリット発動時に一瞬だけ出す「それっぽい」メッセージ（一覧や説明としては出さない）。 */
const TRAIT_MESSAGE: Readonly<Record<TraitId, string>> = {
  "c.null_pointer": "Segmentation fault (core dumped)",
  "cpp.memory_leak": "==1337== definitely lost: 1 block",
  "js.undefined": "TypeError: undefined is not a function",
  "php.type_juggling": '"1" == 1  // true ?!',
  "java.swt_leak": "Color#dispose() が呼ばれていない…",
};

const AVATAR_X: Readonly<Record<Side, number>> = { Player: 320, Cpu: GAME_WIDTH - 320 };
const AVATAR_Y = 270;
const CARD_Y = 620;
const CARD_W = 150;
const CARD_H = 112;
const THUNK_COLOR = 0xb48ead;
const THUNK_CSS = "#d7a6ff";
/** 左右のアバターに重ならない中央メッセージの最大幅。 */
const MESSAGE_MAX_WIDTH = 400;
const MAX_THUNK_CHIPS = 6;

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

/** 名前の横・HP バーの下に並べる状態表示。 */
interface Badges {
  readonly wins: Phaser.GameObjects.Text;
  readonly thunks: Phaser.GameObjects.Text;
  readonly stw: Phaser.GameObjects.Text;
  /** サンクの可視化（アバターの上に積まれるチップ）。 */
  readonly chips: Phaser.GameObjects.Container;
  shownThunks: number;
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
  readonly sub: Phaser.GameObjects.Text;
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
  /** イベントループの追加の 1 手か。 */
  readonly extra: boolean;
  cursor: Move;
}

/**
 * 表示専用。ゲーム状態は持たず、エンジンから届く View をそのまま描く。
 * 相手情報は OpponentView（手札内訳は Python 発動後のみ Some、サンクは常に Some）と、
 * 手選択中に限り ChoiceView.opponentHandTotal しか受け取らない。隠れデメリットの内部状態は受け取らない。
 */
export class BattleUi {
  private readonly hp: Record<Side, HpBar>;
  private readonly badges: Record<Side, Badges>;
  private readonly avatars: Record<Side, FighterAvatar>;
  private readonly colors: Record<Side, number>;
  private readonly skillText: Record<Side, Phaser.GameObjects.Text>;
  private readonly discardLabel: Record<Side, Phaser.GameObjects.Text>;
  private readonly ownStatus: Phaser.GameObjects.Text;
  private readonly opponentHand: Phaser.GameObjects.Text;
  private readonly turnText: Phaser.GameObjects.Text;
  private readonly message: Phaser.GameObjects.Text;
  private readonly banner: Banner;
  private readonly cards: Record<Move, HandCard>;
  private readonly reveal: Record<Side, RevealCard>;
  private readonly extraReveal: Record<Side, RevealCard>;
  private readonly hint: Phaser.GameObjects.Text;
  /** 試合終了後に手札カードの位置へ出すボタン。 */
  private readonly endButtons: readonly Phaser.GameObjects.Container[];
  private selection: Selection | null = null;
  private wins: Readonly<Record<Side, number>> = { Player: 0, Cpu: 0 };
  private ended = false;
  private toastY = 0;

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
    this.badges = {
      Player: this.makeBadges("Player", 40, self.character.name),
      Cpu: this.makeBadges("Cpu", GAME_WIDTH - 40, `${opponent.character.name} (CPU)`),
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
    this.ownStatus = scene.add.text(80, 500, "", textStyle(20, "#ffd866"));
    this.opponentHand = scene.add.text(GAME_WIDTH - 560, 500, "", textStyle(22, "#ffd866"));
    this.message = scene.add
      .text(GAME_WIDTH / 2, AVATAR_Y, "", { ...textStyle(30), align: "center", fontStyle: "bold" })
      .setOrigin(0.5)
      .setStroke("#000000", 6)
      .setDepth(30);
    this.reveal = { Player: this.makeRevealCard(), Cpu: this.makeRevealCard() };
    this.extraReveal = { Player: this.makeRevealCard(), Cpu: this.makeRevealCard() };

    this.cards = {
      Slash: this.makeCard("Slash", GAME_WIDTH / 2 - 170),
      Thrust: this.makeCard("Thrust", GAME_WIDTH / 2),
      Bash: this.makeCard("Bash", GAME_WIDTH / 2 + 170),
    };
    this.endButtons = [
      createButton(scene, GAME_WIDTH / 2 - 140, CARD_Y, "リスタート (R)", handlers.onRestart, 250),
      createButton(scene, GAME_WIDTH / 2 + 140, CARD_Y, "キャラ選択へ (C)", handlers.onBackToSelect, 250),
    ];
    for (const b of this.endButtons) b.setVisible(false);
    this.hint = scene.add.text(GAME_WIDTH / 2, 700, "", textStyle(18, "#9aa4b8")).setOrigin(0.5);
    // じゃんけんの対応（常に表示）
    scene.add
      .text(
        GAME_WIDTH / 2,
        536,
        MOVES.map((m) => `${MOVE_HAND[m].emoji}${MOVE_HAND[m].name}（${MOVE_NAME[m]}）`).join("  ＞  ") +
          `  ＞  ${MOVE_HAND.Slash.emoji}`,
        textStyle(16, "#9aa4b8"),
      )
      .setOrigin(0.5);
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

  /** 左側は x から右へ、右側は x から左へ並べる。 */
  private makeBadges(side: Side, x: number, name: string): Badges {
    const left = side === "Player";
    const ox = left ? 0 : 1;
    const nameWidth = this.scene.add.text(0, 0, name, textStyle(22)).setVisible(false).width;
    const wins = this.scene.add.text(x, 94, "", textStyle(20, "#ffd866")).setOrigin(ox, 0);
    const thunks = this.scene.add.text(left ? x + 70 : x - 70, 94, "", textStyle(20, THUNK_CSS)).setOrigin(ox, 0);
    const stw = this.scene.add
      .text(left ? x + nameWidth + 14 : GAME_WIDTH - 40 - 480 + nameWidth + 14, 30, "", {
        ...textStyle(18, "#ff6b6b"),
        fontStyle: "bold",
      })
      .setOrigin(0, 0);
    const chips = this.scene.add.container(AVATAR_X[side], 132).setDepth(5);
    return { wins, thunks, stw, chips, shownThunks: 0 };
  }

  /** 手札カード。ホバーで持ち上がって光り、クリックで決定（キーボードの A/D・J と同じ動作）。 */
  private makeCard(move: Move, x: number): HandCard {
    const box = this.scene.add
      .rectangle(0, 0, CARD_W, CARD_H, 0x2a2f3a)
      .setStrokeStyle(3, 0x596275)
      .setInteractive({ useHandCursor: true });
    box.on(Phaser.Input.Events.GAMEOBJECT_POINTER_OVER, () => {
      this.focus(move);
    });
    box.on(Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN, () => {
      this.pick(move);
    });
    const label = this.scene.add.text(0, 0, "", { ...textStyle(20), align: "center", lineSpacing: 2 }).setOrigin(0.5);
    const root = this.scene.add.container(x, CARD_Y, [box, label]);
    return { root, box, label, glow: addGlow(this.scene, root, CARD_W, CARD_H, 0xffd866), look: null };
  }

  private makeRevealCard(): RevealCard {
    const box = this.scene.add.rectangle(0, 0, 120, 150, 0x1b1f2a).setStrokeStyle(4, 0xffffff, 0.9);
    const label = this.scene.add.text(0, -6, "", { ...textStyle(64), fontStyle: "bold" }).setOrigin(0.5);
    const sub = this.scene.add.text(0, 52, "", textStyle(16, "#c8d0e0")).setOrigin(0.5);
    const root = this.scene.add
      .container(GAME_WIDTH / 2, AVATAR_Y - 30, [box, label, sub])
      .setDepth(20)
      .setVisible(false);
    return { root, label, sub };
  }

  private makeBanner(): Banner {
    const cy = GAME_HEIGHT / 2;
    const bg = this.scene.add.rectangle(0, 0, GAME_WIDTH, 170, 0x05070b, 0.86);
    const stripes = [
      this.scene.add.rectangle(0, -85, GAME_WIDTH, 4, 0xffd866),
      this.scene.add.rectangle(0, 85, GAME_WIDTH, 4, 0xffd866),
    ];
    const title = this.scene.add.text(0, -30, "", { ...textStyle(44, "#ffd866"), fontStyle: "bold" }).setOrigin(0.5);
    const body = this.scene.add.text(0, 35, "", { ...textStyle(22), align: "center" }).setOrigin(0.5);
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

  /** サンク：数と累積ダメージを常に表示し、アバターの上にチップとして積む。 */
  private renderThunks(side: Side, thunks: Option.Option<ThunkView>): void {
    const b = this.badges[side];
    Option.match(thunks, {
      onNone: () => {
        b.thunks.setText("");
      },
      onSome: (t) => {
        b.thunks.setText(t.forced ? "サンク：評価済み" : `サンク ×${String(t.count)}（累積 ${String(t.total)}）`);
      },
    });
    const count = Option.match(thunks, { onNone: () => 0, onSome: (t) => (t.forced ? 0 : t.count) });
    if (count === b.shownThunks) return;
    const grew = count > b.shownThunks;
    b.shownThunks = count;
    b.chips.removeAll(true);
    const shown = Math.min(count, MAX_THUNK_CHIPS);
    const width = 46;
    const left = -((shown - 1) * width) / 2;
    for (let i = 0; i < shown; i++) {
      const last = i === shown - 1;
      const label = last && count > MAX_THUNK_CHIPS ? `+${String(count - MAX_THUNK_CHIPS + 1)}` : "λ";
      const chip = this.scene.add.container(left + i * width, 0, [
        this.scene.add.rectangle(0, 0, 40, 24, THUNK_COLOR, 0.9).setStrokeStyle(2, 0xffffff, 0.6),
        this.scene.add.text(0, 0, label, { ...textStyle(16), fontStyle: "bold" }).setOrigin(0.5),
      ]);
      b.chips.add(chip);
      if (grew && last) popIn(this.scene, chip, 0, 0.3);
    }
    punch(this.scene, b.thunks, 1.15, 120);
  }

  private renderBadges(view: BattleView): void {
    for (const side of SIDES) {
      const v = side === "Player" ? view.self : view.opponent;
      const b = this.badges[side];
      const pips = Array.from({ length: 2 }, (_, i) => (i < this.wins[side] ? "●" : "○")).join("");
      b.wins.setText(pips);
      b.stw.setText(v.stwPenalty > 0 ? `STW -${String(v.stwPenalty)}` : "");
    }
  }

  private renderVitals(view: BattleView): void {
    this.renderHp("Player", view.self.hp, view.self.character.maxHp);
    this.renderHp("Cpu", view.opponent.hp, view.opponent.character.maxHp);
    this.renderThunks("Player", view.self.thunks);
    this.renderThunks("Cpu", view.opponent.thunks);
  }

  private renderSkill(side: Side, v: OwnView | OpponentView): void {
    const { skill } = v;
    const state = skill.repeatable
      ? skill.activations > 0
        ? `（${String(skill.activations)} 回）`
        : ""
      : skill.used
        ? "（使用済み）"
        : "";
    this.skillText[side].setText(`スキル「${skill.name}」${state}`);
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
    const locked = Option.getOrNull(self.locked);
    for (const m of MOVES) {
      const card = this.cards[m];
      const count = self.hand[m];
      const lockMark = locked === m ? "  🔒1" : "";
      // 斬撃 / ✊ グー / ×3 の 3 段。素手なら枚数の代わりに「素手」
      const hand = `${MOVE_HAND[m].emoji} ${MOVE_HAND[m].name}`;
      const amount = self.bare ? "素手" : `×${String(count)}${lockMark}`;
      card.label.setText(`${MOVE_NAME[m]}\n${hand}\n${amount}`);
      const playable = sel === null ? self.bare || count > 0 : sel.view.playable.includes(m);
      const look: CardLook = !playable ? "empty" : sel === null ? "locked" : sel.cursor === m ? "focus" : "idle";
      this.setCardLook(card, look);
    }
    if (sel === null) {
      this.hint.setText("");
    } else if (sel.extra) {
      this.hint.setText("イベントループ：追加の 1 手を選んでください（どちらかが勝てば勝ち）");
    } else {
      this.hint.setText("クリックで決定    ／    A / D : 手を選ぶ    J : 決定");
    }
    const divisor = self.character.bareHandDivisor;
    this.ownStatus.setText(self.bare ? `素手：与ダメージ 1/${String(divisor)}（端数切り上げ）` : "");
  }

  /**
   * 相手の手札表示。
   * - Python 発動後（revealedHand が Some）：内訳を常に表示
   * - 手選択中：合計枚数のみ（0 なら素手）
   * - それ以外：何も表示しない
   */
  private renderOpponentHand(opponent: OpponentView, total: Option.Option<number>): void {
    const text = Option.match(opponent.revealedHand, {
      onSome: (hand) => `相手の手札: ${handText(hand)}`,
      onNone: () =>
        Option.match(total, {
          onSome: (n) => (n === 0 ? "相手の手札: 0 枚（素手）" : `相手の手札: 残り ${String(n)} 枚`),
          onNone: () => "",
        }),
    });
    this.opponentHand.setText(text);
  }

  /** withVitals = false のときは HP・サンクを据え置く（オープン演出で命中に合わせて変えるため）。 */
  render(view: BattleView, opponentTotal: Option.Option<number>, withVitals = true): void {
    const { self, opponent } = view;
    if (!this.ended) this.turnText.setText(`Round ${String(view.round)}  ·  Turn ${String(view.turn)}`);
    if (withVitals) this.renderVitals(view);
    this.renderBadges(view);
    this.renderSkill("Player", self);
    this.renderSkill("Cpu", opponent);
    this.discardLabel.Player.setText(`自分の捨て札: ${discardText(self.discard)}`);
    this.discardLabel.Cpu.setText(`相手の捨て札: ${discardText(opponent.discard)}`);
    if (!this.ended) this.renderOwnHand(self);
    this.renderOpponentHand(opponent, opponentTotal);
    this.avatars.Player.setActive(this.selection !== null);
  }

  private showBanner(title: string, body: string, color: number, ms: number): void {
    const b = this.banner;
    b.title.setText(title);
    b.body.setText(body);
    b.body.setScale(Math.min(1, (GAME_WIDTH - 80) / Math.max(1, b.body.width)));
    for (const s of b.stripes) s.setFillStyle(color);
    this.scene.tweens.killTweensOf([b.root, b.bg, b.title, b.body, ...b.stripes]);
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

  /** 右下に積み重なるトースト（実績解除など）。アバター・HP 表示に重ならない位置。 */
  private showToast(text: string): void {
    const { scene } = this;
    const y = 560 - this.toastY * 62;
    this.toastY += 1;
    const bg = scene.add.rectangle(0, 0, 380, 52, 0x11141c, 0.95).setStrokeStyle(2, 0xffd866);
    const label = scene.add.text(-176, 0, text, { ...textStyle(20, "#ffd866"), fontStyle: "bold" }).setOrigin(0, 0.5);
    label.setScale(Math.min(1, 352 / label.width));
    const root = scene.add.container(GAME_WIDTH + 210, y, [bg, label]).setDepth(80);
    scene.tweens.add({ targets: root, x: GAME_WIDTH - 210, duration: 360, ease: "Back.easeOut" });
    scene.tweens.add({
      targets: root,
      x: GAME_WIDTH + 210,
      duration: 300,
      delay: 3200,
      ease: "Cubic.easeIn",
      onComplete: () => {
        root.destroy();
        this.toastY = Math.max(0, this.toastY - 1);
      },
    });
    burst(scene, GAME_WIDTH - 210, y, [0xffd866, 0xffffff], 16);
  }

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

  private playRoundStart(view: BattleView, round: number, wins: Readonly<Record<Side, number>>): number {
    this.wins = wins;
    this.ended = false;
    this.renderBadges(view);
    for (const b of this.endButtons) b.setVisible(false);
    for (const card of Object.values(this.cards)) {
      card.look = null;
      this.scene.tweens.add({ targets: card.root, alpha: 1, y: CARD_Y, duration: 200 });
    }
    if (round === 1) {
      this.avatars.Player.enter(0);
      this.avatars.Cpu.enter(80);
      this.message.setFontSize(48).setColor("#ffffff").setY(AVATAR_Y);
      this.message.setText(`${view.self.character.name}  VS  ${view.opponent.character.name}`);
      this.fitMessage();
      popIn(this.scene, this.message, 380, 1.8);
      this.scene.time.delayedCall(560, () => {
        flash(this.scene, 0xffffff, 140);
        burst(this.scene, GAME_WIDTH / 2, AVATAR_Y, [this.colors.Player, this.colors.Cpu, 0xffffff], 30);
        this.avatars.Player.startIdle();
        this.avatars.Cpu.startIdle();
      });
      this.scene.tweens.add({ targets: this.message, alpha: 0, duration: 200, delay: TIMING.roundIntro - 220 });
      return TIMING.roundIntro;
    }
    // 2 試合目以降：勝敗の演出を戻して「Round N」
    for (const side of SIDES) {
      this.avatars[side].reset();
      this.avatars[side].startIdle();
    }
    this.showBanner(
      `Round ${String(round)}`,
      `${String(wins.Player)} - ${String(wins.Cpu)}`,
      0xffd866,
      TIMING.roundStart,
    );
    return TIMING.roundStart;
  }

  private setRevealCard(card: RevealCard, play: { label: string; sub: string; small: boolean }): void {
    card.label.setText(play.label).setFontSize(play.small ? 26 : 64);
    card.sub.setText(play.sub);
  }

  private revealContent(p: RevealedPlay): { label: string; sub: string; small: boolean } {
    const bare = p.bare ? "素手" : "";
    const e: EffectiveMove = p.effective;
    switch (e._tag) {
      case "Move":
        return e.move === p.chosen
          ? {
              label: MOVE_LABEL[e.move],
              sub: `${MOVE_HAND[e.move].emoji} ${MOVE_HAND[e.move].name}${bare === "" ? "" : ` · ${bare}`}`,
              small: false,
            }
          : { label: `${MOVE_LABEL[p.chosen]}→${MOVE_LABEL[e.move]}`, sub: "== ?!", small: true };
      case "Undefined":
        return { label: "undefined", sub: MOVE_NAME[p.chosen], small: true };
      case "Fizzle":
        return { label: "NULL", sub: "不発", small: true };
    }
  }

  /** 両者のカードをめくる。 */
  private playReveal(plays: Readonly<Record<Side, RevealedPlay>>): void {
    const { scene } = this;
    const startX: Record<Side, number> = { Player: GAME_WIDTH / 2 - 110, Cpu: GAME_WIDTH / 2 + 110 };
    for (const side of SIDES) {
      this.extraReveal[side].root.setVisible(false);
      const card = this.reveal[side];
      this.setRevealCard(card, this.revealContent(plays[side]));
      card.root
        .setVisible(true)
        .setPosition(AVATAR_X[side], AVATAR_Y - 30)
        .setScale(0, 1)
        .setAlpha(1)
        .setAngle(0);
      scene.tweens.add({ targets: card.root, x: startX[side], scaleX: 1, duration: 240, ease: "Back.easeOut" });
    }
  }

  /** イベントループの追加の 1 手を、そのキャラのカードの外側に出す。 */
  private playExtra(side: Side, move: Move): void {
    const card = this.extraReveal[side];
    this.setRevealCard(card, { label: MOVE_LABEL[move], sub: "event loop", small: false });
    const x = side === "Player" ? GAME_WIDTH / 2 - 240 : GAME_WIDTH / 2 + 240;
    card.root
      .setVisible(true)
      .setPosition(x, AVATAR_Y - 30)
      .setScale(1)
      .setAlpha(1)
      .setAngle(0);
    popIn(this.scene, card.root, 0, 0.4);
    burst(this.scene, x, AVATAR_Y - 30, [0xf7df1e, 0xffffff], 18);
  }

  /** 中央でぶつけ、命中に合わせて HP・サンクを変える。 */
  private playResolve(event: Extract<BattleEvent, { _tag: "ExchangeResolved" }>): void {
    const { scene } = this;
    const { view, outcome, damage } = event;
    const winner: Side | null = outcome === "Draw" ? null : outcome === "Win" ? "Player" : "Cpu";
    const startX: Record<Side, number> = { Player: GAME_WIDTH / 2 - 110, Cpu: GAME_WIDTH / 2 + 110 };
    const cardsOf = (side: Side) => [this.reveal[side].root, this.extraReveal[side].root].filter((c) => c.visible);
    for (const side of SIDES) {
      scene.tweens.add({
        targets: cardsOf(side),
        x: `${side === "Player" ? "+" : "-"}=48`,
        duration: 110,
        ease: "Quad.easeIn",
      });
    }
    if (winner !== null) this.avatars[winner].lunge();

    scene.time.delayedCall(120, () => {
      const colors = winner === null ? [0xffffff, 0xc8d0e0] : [this.colors[winner], 0xffd866, 0xffffff];
      burst(scene, GAME_WIDTH / 2, AVATAR_Y - 30, colors, winner === null ? 18 : 34);
      if (winner === null || damage === null) {
        shake(scene, 0.004, 140);
        for (const side of SIDES) {
          scene.tweens.add({ targets: this.reveal[side].root, x: startX[side], duration: 220, ease: "Back.easeOut" });
        }
      } else {
        const loser = damage.target;
        flash(scene, 0xffffff, 90);
        shake(scene, damage.amount >= 20 ? 0.014 : 0.008, 240);
        this.avatars[loser].hit();
        if (damage.deferred) {
          floatText(scene, AVATAR_X[loser], AVATAR_Y - 50, `+${String(damage.amount)} サンク`, THUNK_CSS, 40);
        } else {
          floatText(
            scene,
            AVATAR_X[loser],
            AVATAR_Y - 50,
            `-${String(damage.amount)}`,
            "#ff6b6b",
            damage.amount >= 20 ? 58 : 46,
          );
        }
        punch(scene, this.reveal[winner].root, 1.25, 140);
        scene.tweens.add({
          targets: cardsOf(loser),
          angle: loser === "Player" ? -35 : 35,
          y: AVATAR_Y + 40,
          alpha: 0,
          scale: 0.6,
          duration: 380,
          ease: "Cubic.easeIn",
        });
      }
      if (event.bashDiscard !== null) {
        const s = event.bashDiscard.side;
        floatText(
          scene,
          AVATAR_X[s],
          AVATAR_Y + 110,
          `手札を叩き落とされた（${event.bashDiscard.moves.map((m) => MOVE_LABEL[m]).join("")}）`,
          "#ffb86c",
          20,
        );
      }
      if (event.thunkDropped !== null) {
        const s = event.thunkDropped.side;
        floatText(
          scene,
          AVATAR_X[s],
          AVATAR_Y - 110,
          `サンク破棄 (${String(event.thunkDropped.amount)})`,
          "#a3e635",
          26,
        );
      }
      this.renderVitals(view);
      this.message
        .setScale(1)
        .setFontSize(34)
        .setColor(OUTCOME_COLOR[outcome])
        .setText(OUTCOME_TEXT[outcome])
        .setY(AVATAR_Y + 110);
      popIn(scene, this.message, 0, 0.5);
    });

    // 片付け
    const all = [...SIDES.flatMap((s) => [this.reveal[s].root, this.extraReveal[s].root]), this.message];
    scene.tweens.add({ targets: all, alpha: 0, duration: 220, delay: TIMING.resolve - 240 });
  }

  private playSkill(side: Side, title: string, body: string, ms: number): void {
    const color = this.colors[side];
    this.avatars[side].pulse(color, Math.min(1200, ms));
    burst(this.scene, AVATAR_X[side], AVATAR_Y, [color, 0xffffff], 28);
    this.showBanner(title, body, color, ms);
  }

  /** Java の Stop The World：「GCが走った！！」 */
  private playStopTheWorld(side: Side, penalty: number): void {
    const { scene } = this;
    const t = scene.add
      .text(GAME_WIDTH / 2, AVATAR_Y - 40, "GCが走った！！", { ...textStyle(72, "#ff6b6b"), fontStyle: "bold" })
      .setOrigin(0.5)
      .setStroke("#000000", 10)
      .setDepth(70);
    const sub = scene.add
      .text(GAME_WIDTH / 2, AVATAR_Y + 30, `Stop The World — 次ターンの与ダメージ -${String(penalty)}`, textStyle(22))
      .setOrigin(0.5)
      .setDepth(70);
    popIn(scene, t, 0, 2.2);
    flash(scene, 0x888888, 200);
    shake(scene, 0.012, 420);
    this.avatars[side].pulse(0x888888, 1000);
    // 「止まった」感：一瞬カクつかせる
    scene.tweens.add({
      targets: t,
      x: { from: GAME_WIDTH / 2 - 6, to: GAME_WIDTH / 2 + 6 },
      duration: 40,
      yoyo: true,
      repeat: 6,
    });
    scene.tweens.add({ targets: [t, sub], alpha: 0, duration: 200, delay: TIMING.stopTheWorld - 220 });
    scene.time.delayedCall(TIMING.stopTheWorld, () => {
      t.destroy();
      sub.destroy();
    });
  }

  private playTrait(event: Extract<BattleEvent, { _tag: "TraitTriggered" }>): void {
    const { scene } = this;
    const x = AVATAR_X[event.side];
    const t = scene.add
      .text(x, AVATAR_Y - 95, TRAIT_MESSAGE[event.traitId], { ...textStyle(20, "#ff9e64"), fontFamily: "monospace" })
      .setOrigin(0.5)
      .setStroke("#000000", 5)
      .setDepth(55);
    t.setScale(Math.min(1, 440 / t.width));
    popIn(scene, t, 0, 0.6);
    this.avatars[event.side].hit();
    shake(scene, 0.005, 160);
    scene.tweens.add({ targets: t, alpha: 0, y: AVATAR_Y - 125, duration: 300, delay: TIMING.trait - 320 });
    scene.time.delayedCall(TIMING.trait, () => {
      t.destroy();
    });
    if (event.firstUnlock) this.showToast(`🏆 実績解除：${event.displayName}`);
  }

  private playThunksForced(side: Side, total: number, view: BattleView): void {
    const { scene } = this;
    const b = this.badges[side];
    scene.tweens.add({ targets: b.chips, y: AVATAR_Y, scale: 0.4, alpha: 0, duration: 380, ease: "Cubic.easeIn" });
    scene.time.delayedCall(400, () => {
      b.chips.setPosition(AVATAR_X[side], 132).setScale(1).setAlpha(1);
      flash(scene, THUNK_COLOR, 180);
      shake(scene, 0.016, 320);
      this.avatars[side].hit();
      burst(scene, AVATAR_X[side], AVATAR_Y, [THUNK_COLOR, 0xffffff], 36);
      floatText(scene, AVATAR_X[side], AVATAR_Y - 50, `強制評価！ -${String(total)}`, THUNK_CSS, 48);
      this.renderVitals(view);
    });
  }

  private playTurnNotes(notes: readonly TurnNote[]): void {
    notes.forEach((n, i) => {
      const text = ((): string => {
        switch (n._tag) {
          case "TempReleased":
            return `free()：一時確保した ${n.moves.map((m) => MOVE_NAME[m]).join("・")} を解放`;
          case "RaiiReturned":
            return `RAII：${MOVE_NAME[n.move]} を回収（次のターンは使用不可）`;
        }
      })();
      floatText(this.scene, AVATAR_X[n.side], AVATAR_Y + 80 + i * 26, text, "#7fdbff", 18);
    });
  }

  private playRoundEnd(view: BattleView, result: RoundResult, wins: Readonly<Record<Side, number>>): void {
    this.wins = wins;
    this.renderBadges(view);
    for (const card of Object.values(this.cards)) {
      this.scene.tweens.add({ targets: card.root, alpha: 0, y: CARD_Y + 30, duration: 200 });
    }
    switch (result._tag) {
      case "Victory": {
        const loser = opponentOf(result.winner);
        this.avatars[result.winner].celebrate();
        this.avatars[loser].defeat();
        const reason = result.reason === "TurnLimit" ? "（上限ターン・HP 割合で判定）" : "";
        this.showBanner(
          `Round ${String(view.round)} — ${this.sideName(view, result.winner)} の勝ち`,
          `${String(wins.Player)} - ${String(wins.Cpu)}${reason}`,
          this.colors[result.winner],
          TIMING.roundEnd,
        );
        break;
      }
      case "Draw":
        this.showBanner(
          `Round ${String(view.round)} — 引き分け`,
          result.reason === "DoubleKnockout"
            ? "相打ち。この試合はやり直し"
            : "上限ターンで HP 割合が同じ。この試合はやり直し",
          0xc8d0e0,
          TIMING.roundEnd,
        );
        break;
    }
  }

  private playMatchEnd(view: BattleView, winner: Side): void {
    this.ended = true;
    this.turnText.setText("マッチ終了");
    this.hint.setText("");
    this.message
      .setAlpha(1)
      .setFontSize(54)
      .setColor("#ffffff")
      .setY(AVATAR_Y)
      .setText(`${this.sideName(view, winner)} Wins\nthe Match!`);
    this.fitMessage();
    popIn(this.scene, this.message, 120, 2);
    this.message.setShadow(0, 0, "#ffd866", 18, true, true);
    confetti(this.scene, AVATAR_X[winner], [this.colors[winner], 0xffd866, 0xffffff, 0x7fdbff]);
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
    // HP・サンクが変わる演出は、見た目の瞬間に合わせて後から反映する
    const deferVitals = event._tag === "ExchangeResolved" || event._tag === "ThunksForced";
    this.render(event.view, Option.none(), !deferVitals);
    const after = (ms: number): (() => void) => {
      const timer = this.scene.time.delayedCall(ms, done);
      return () => {
        timer.remove(false);
      };
    };
    switch (event._tag) {
      case "RoundStarted":
        return after(this.playRoundStart(event.view, event.round, event.wins));
      case "TurnStarted":
        punch(this.scene, this.turnText, 1.2, 140);
        return after(TIMING.turnIntro);
      case "SkillActivated": {
        const v = event.side === "Player" ? event.view.self : event.view.opponent;
        const ms = v.skill.activations > 1 ? TIMING.skillBannerRepeat : TIMING.skillBanner;
        this.playSkill(event.side, `${this.sideName(event.view, event.side)}：${event.name}`, event.description, ms);
        return after(ms);
      }
      case "StopTheWorld":
        this.playStopTheWorld(event.side, event.penalty);
        return after(TIMING.stopTheWorld);
      case "TraitTriggered":
        this.playTrait(event);
        return after(TIMING.trait);
      case "ThunksForced":
        this.playThunksForced(event.side, event.total, event.view);
        return after(TIMING.thunksForced);
      case "MovesRevealed":
        this.playReveal(event.plays);
        return after(TIMING.reveal);
      case "ExtraMovePlayed":
        this.playExtra(event.side, event.move);
        return after(TIMING.extraMove);
      case "ExchangeResolved":
        this.playResolve(event);
        return after(TIMING.resolve);
      case "TurnEnded":
        this.playTurnNotes(event.notes);
        return after(TIMING.turnNotes);
      case "RoundEnded":
        this.playRoundEnd(event.view, event.result, event.wins);
        return after(TIMING.roundEnd);
      case "MatchEnded":
        this.playMatchEnd(event.view, event.winner);
        return after(0);
    }
  }

  /** 手選択を開始。決定すると onDecide を一度だけ呼び、以後オープンまで入力不可。 */
  beginSelection(view: ChoiceView, onDecide: (move: Move) => void, extra = false): () => void {
    const first = view.playable[0] ?? "Slash";
    this.selection = { view, onDecide, extra, cursor: first };
    this.render(view, Option.some(view.opponentHandTotal), !extra);
    return () => {
      this.endSelection(view);
    };
  }

  /** イベントループの追加の 1 手。相手のオープン済みの手は場に出ている。 */
  beginExtraSelection(view: ExtraChoiceView, onDecide: (move: Move) => void): () => void {
    return this.beginSelection(view, onDecide, true);
  }

  private endSelection(view: BattleView): void {
    this.selection = null;
    this.render(view, Option.none(), false);
  }

  moveCursor(delta: 1 | -1): void {
    const sel = this.selection;
    if (sel === null) return;
    const moves = sel.view.playable;
    const i = moves.indexOf(sel.cursor);
    const next = moves[(i + delta + moves.length) % moves.length];
    if (next === undefined) return;
    sel.cursor = next;
    this.render(sel.view, Option.some(sel.view.opponentHandTotal), false);
  }

  /** 指定の手にカーソルを合わせる（出せない手は無視）。 */
  focus(move: Move): void {
    const sel = this.selection;
    if (sel === null || !sel.view.playable.includes(move) || sel.cursor === move) return;
    sel.cursor = move;
    this.render(sel.view, Option.some(sel.view.opponentHandTotal), false);
  }

  /** 指定の手で即決定する（クリック操作）。 */
  pick(move: Move): void {
    const sel = this.selection;
    if (!sel?.view.playable.includes(move)) return;
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
