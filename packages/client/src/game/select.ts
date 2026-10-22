import * as Phaser from "phaser";
import type { CharacterRoster, CharacterSpec } from "@pbj/shared/characters";
import { MOVE_LABEL, MOVES } from "@pbj/shared/move";
import { createAvatar, type FighterAvatar } from "./avatar";
import { addGlow, burst, createBackdrop, flash, type Glow, popIn, punch, reducedMotion } from "./fx";
import type { Matchup, SelectState } from "./selectState";
import { createButton, GAME_HEIGHT, GAME_WIDTH, textStyle, wrapByChars } from "./widgets";

export interface SelectHandlers {
  readonly onFocus: (index: number) => void;
  readonly onPick: (index: number) => void;
  readonly onBack: () => void;
  readonly onRandom: () => void;
  readonly onAchievements: () => void;
}

interface CharacterCard {
  readonly root: Phaser.GameObjects.Container;
  readonly frame: Phaser.GameObjects.Rectangle;
  readonly badge: Phaser.GameObjects.Text;
  readonly avatar: FighterAvatar;
  readonly glow: Glow;
  focused: boolean | null;
}

const CARD = { width: 156, height: 250, y: 245 } satisfies Record<string, number>;
const STEP_COLOR = { PickPlayer: 0xffd866, PickCpu: 0xff6b6b } satisfies Record<string, number>;

/** VS スプラッシュの長さ（ms）。これが終わってから戦闘 Scene へ移る。 */
export const VERSUS_MS = 1100;

const cardsText = (c: CharacterSpec): string => MOVES.map((m) => `${MOVE_LABEL[m]}${String(c.cards[m])}`).join(" ");

/**
 * キャラクター選択画面の描画。状態は持たず、SelectState をそのまま描く。
 * 表示するのは公開情報（HP・手札・スキル）だけ。隠れデメリットはここに一切出さない。
 */
export class SelectUi {
  private readonly cards: readonly CharacterCard[];
  private readonly stepText: Phaser.GameObjects.Text;
  private readonly detailTitle: Phaser.GameObjects.Text;
  private readonly detailBody: Phaser.GameObjects.Text;
  private readonly summary: Phaser.GameObjects.Text;
  private readonly backButton: Phaser.GameObjects.Container;
  private lastStep: SelectState["_tag"] | null = null;
  private lastDetail = -1;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly roster: CharacterRoster,
    handlers: SelectHandlers,
  ) {
    const accents: [number, number] = [
      roster[0].placeholder.color,
      roster[roster.length - 1]?.placeholder.color ?? roster[0].placeholder.color,
    ];
    createBackdrop(scene, accents);

    scene.add
      .text(GAME_WIDTH / 2, 40, "キャラクター選択", { ...textStyle(36), fontStyle: "bold" })
      .setOrigin(0.5)
      .setStroke("#0b0d12", 6);
    this.stepText = scene.add.text(GAME_WIDTH / 2, 88, "", textStyle(24)).setOrigin(0.5);

    const spacing = Math.min(172, (GAME_WIDTH - 60) / roster.length);
    const left = GAME_WIDTH / 2 - (spacing * (roster.length - 1)) / 2;
    this.cards = roster.map((c, i) => this.makeCard(c, i, left + spacing * i, handlers));

    // 詳細パネル（カーソルの当たっているキャラ）
    scene.add.rectangle(GAME_WIDTH / 2, 462, GAME_WIDTH - 120, 136, 0x11141c, 0.88).setStrokeStyle(2, 0x3b4252);
    this.detailTitle = scene.add.text(100, 404, "", { ...textStyle(22, "#ffd866"), fontStyle: "bold" });
    this.detailBody = scene.add.text(100, 438, "", { ...textStyle(18, "#c8d0e0"), lineSpacing: 4 });

    this.summary = scene.add.text(GAME_WIDTH / 2, 565, "", textStyle(26)).setOrigin(0.5);
    this.backButton = createButton(scene, GAME_WIDTH / 2 - 260, 628, "戻る (K)", handlers.onBack);
    const randomButton = createButton(scene, GAME_WIDTH / 2, 628, "おまかせ (R)", handlers.onRandom);
    const achievements = createButton(scene, GAME_WIDTH / 2 + 260, 628, "🏆 実績 (Q)", handlers.onAchievements);
    popIn(scene, randomButton, 400, 0.7);
    popIn(scene, achievements, 480, 0.7);
    scene.add
      .text(
        GAME_WIDTH / 2,
        690,
        "クリックで決定    ／    A / D : 選ぶ    J : 決定    K : 戻る    R : おまかせ    Q : 実績",
        textStyle(18, "#9aa4b8"),
      )
      .setOrigin(0.5);
  }

  private makeCard(c: CharacterSpec, i: number, x: number, handlers: SelectHandlers): CharacterCard {
    const { scene } = this;
    const frame = scene.add
      .rectangle(0, 0, CARD.width, CARD.height, 0x1b1f2a, 0.92)
      .setStrokeStyle(2, 0x596275)
      .setInteractive({ useHandCursor: true });
    frame.on(Phaser.Input.Events.GAMEOBJECT_POINTER_OVER, () => {
      handlers.onFocus(i);
    });
    frame.on(Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN, () => {
      handlers.onPick(i);
    });
    // カード上部にキャラ色の帯
    const band = scene.add.rectangle(0, -CARD.height / 2 + 3, CARD.width - 4, 6, c.placeholder.color);
    const avatar = createAvatar(scene, c, 0, -52);
    avatar.root.setScale(0.5);
    const stats = scene.add
      .text(0, 30, `HP ${String(c.maxHp)}\n${cardsText(c)}`, { ...textStyle(17), align: "center" })
      .setOrigin(0.5, 0);
    const skill = scene.add
      .text(0, 78, wrapByChars(c.skill.displayName, 8), { ...textStyle(15, "#ffd866"), align: "center" })
      .setOrigin(0.5, 0);
    const badge = scene.add
      .text(0, -CARD.height / 2 - 22, "", { ...textStyle(16, "#ffd866"), fontStyle: "bold" })
      .setOrigin(0.5, 0);
    const root = scene.add.container(x, CARD.y, [frame, band, avatar.root, stats, skill, badge]);

    // 左から順に浮かび上がる
    root.setAlpha(0).setY(CARD.y + 40);
    scene.tweens.add({ targets: root, y: CARD.y, alpha: 1, duration: 420, delay: 70 * i, ease: "Cubic.easeOut" });
    return { root, frame, badge, avatar, glow: addGlow(scene, root, CARD.width, CARD.height, 0xffd866), focused: null };
  }

  private setFocused(card: CharacterCard, focused: boolean, color: number): void {
    card.frame.setStrokeStyle(focused ? 4 : 2, focused ? color : 0x596275);
    card.frame.setFillStyle(focused ? 0x262c3a : 0x1b1f2a, 0.92);
    card.glow.setColor(color);
    if (card.focused === focused) return;
    card.focused = focused;
    card.glow.set(focused);
    this.scene.tweens.add({ targets: card.root, scale: focused ? 1.05 : 1, duration: 150, ease: "Quad.easeOut" });
    if (focused) card.avatar.startIdle();
  }

  private renderDetail(index: number): void {
    if (index === this.lastDetail) return;
    this.lastDetail = index;
    const c = this.roster[index];
    if (c === undefined) return;
    const bare = `素手 1/${String(c.bareHandDivisor)}`;
    this.detailTitle.setText(
      `${c.placeholder.emoji} ${c.name}  HP ${String(c.maxHp)}  ${cardsText(c)}  ${bare}  —  「${c.skill.displayName}」`,
    );
    this.detailBody.setText(`${c.skill.concept}\n${wrapByChars(c.skill.description, 58)}`);
    this.detailBody.setAlpha(0);
    this.scene.tweens.add({ targets: this.detailBody, alpha: 1, duration: 160 });
  }

  render(state: SelectState): void {
    switch (state._tag) {
      case "PickPlayer":
      case "PickCpu":
        break;
      case "Done":
        return;
    }
    const picking = state._tag === "PickPlayer";
    const playerId = picking ? undefined : state.player.id;
    const focusName = this.roster[state.cursor]?.name ?? "？";
    const color = STEP_COLOR[state._tag];
    this.stepText.setText(picking ? "あなたのキャラを選んでください" : "相手（CPU）のキャラを選んでください");
    this.stepText.setColor(picking ? "#ffffff" : "#ffb3b3");
    if (this.lastStep !== state._tag) {
      // 段階が変わったら見出しを弾ませる
      if (this.lastStep !== null) punch(this.scene, this.stepText, 1.15, 140);
      this.lastStep = state._tag;
    }
    this.summary.setText(
      picking ? `あなた: ${focusName}    VS    CPU: ？` : `あなた: ${state.player.name}    VS    CPU: ${focusName}`,
    );
    this.backButton.setVisible(!picking);
    this.renderDetail(state.cursor);
    this.cards.forEach((card, i) => {
      this.setFocused(card, i === state.cursor, color);
      const isPlayer = this.roster[i]?.id === playerId;
      const wasEmpty = card.badge.text === "";
      card.badge.setText(isPlayer ? "▼ あなた" : "");
      if (isPlayer && wasEmpty) popIn(this.scene, card.badge, 0, 0.4);
    });
  }

  /** 決定時の VS スプラッシュ。終わったら onDone。 */
  playVersus(matchup: Matchup, onDone: () => void): void {
    const { scene } = this;
    const cy = GAME_HEIGHT / 2;
    const dim = scene.add.rectangle(GAME_WIDTH / 2, cy, GAME_WIDTH, GAME_HEIGHT, 0x05070b, 0).setDepth(70);
    scene.tweens.add({ targets: dim, fillAlpha: 0.85, duration: 200 });

    const side = (c: CharacterSpec, dir: 1 | -1, label: string): void => {
      const x = GAME_WIDTH / 2 - dir * 300;
      const stripe = scene.add.rectangle(x, cy, 520, 200, c.placeholder.color, 0.9).setDepth(71).setAngle(-8);
      const name = scene.add
        .text(x, cy - 10, c.name, { ...textStyle(56), fontStyle: "bold" })
        .setOrigin(0.5)
        .setStroke("#000000", 8)
        .setDepth(72);
      const tag = scene.add
        .text(x, cy + 50, label, textStyle(22, "#ffffff"))
        .setOrigin(0.5)
        .setDepth(72);
      for (const o of [stripe, name, tag]) {
        const targetX = o.x;
        o.setX(targetX - dir * 700);
        scene.tweens.add({ targets: o, x: targetX, duration: 320, delay: 80, ease: "Cubic.easeOut" });
      }
    };
    side(matchup.P1, 1, "あなた");
    side(matchup.P2, -1, "CPU");

    const vs = scene.add
      .text(GAME_WIDTH / 2, cy, "VS", { ...textStyle(96, "#ffd866"), fontStyle: "bold" })
      .setOrigin(0.5)
      .setStroke("#000000", 10)
      .setDepth(73);
    popIn(scene, vs, 380, 2.4);
    scene.time.delayedCall(420, () => {
      flash(scene, 0xffffff, 120);
      burst(scene, GAME_WIDTH / 2, cy, [matchup.P1.placeholder.color, matchup.P2.placeholder.color, 0xffd866], 40);
      if (!reducedMotion()) scene.cameras.main.shake(180, 0.006);
    });
    scene.time.delayedCall(VERSUS_MS, onDone);
  }
}
