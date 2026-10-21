import * as Phaser from "phaser";
import type { CharacterDef, CharacterRoster } from "../core/characters";
import { MOVE_LABEL, MOVES } from "../core/move";
import { createAvatar } from "./avatar";
import type { SelectState } from "./selectState";
import { createButton, GAME_WIDTH, textStyle, wrapByChars } from "./widgets";

export interface SelectHandlers {
  readonly onFocus: (index: number) => void;
  readonly onPick: (index: number) => void;
  readonly onBack: () => void;
  readonly onRandom: () => void;
}

interface CharacterCard {
  readonly frame: Phaser.GameObjects.Rectangle;
  readonly badge: Phaser.GameObjects.Text;
}

const CARD = { width: 260, height: 430, y: 335 } satisfies Record<string, number>;
const STEP_COLOR = { PickPlayer: 0xffd866, PickCpu: 0xff6b6b } satisfies Record<string, number>;

const statsText = (c: CharacterDef): string =>
  `HP ${String(c.maxHp)}\n${MOVES.map((m) => `${MOVE_LABEL[m]}${String(c.cards[m])}`).join("  ")}`;

/** キャラクター選択画面の描画。状態は持たず、SelectState をそのまま描く。 */
export class SelectUi {
  private readonly cards: readonly CharacterCard[];
  private readonly stepText: Phaser.GameObjects.Text;
  private readonly summary: Phaser.GameObjects.Text;
  private readonly backButton: Phaser.GameObjects.Container;

  constructor(
    scene: Phaser.Scene,
    private readonly roster: CharacterRoster,
    handlers: SelectHandlers,
  ) {
    scene.add.text(GAME_WIDTH / 2, 40, "キャラクター選択", textStyle(36)).setOrigin(0.5);
    this.stepText = scene.add.text(GAME_WIDTH / 2, 88, "", textStyle(24)).setOrigin(0.5);

    const spacing = Math.min(290, (GAME_WIDTH - 100) / roster.length);
    const left = GAME_WIDTH / 2 - (spacing * (roster.length - 1)) / 2;
    this.cards = roster.map((c, i) => {
      const x = left + spacing * i;
      const frame = scene.add
        .rectangle(x, CARD.y, CARD.width, CARD.height, 0x1b1f2a)
        .setStrokeStyle(2, 0x596275)
        .setInteractive({ useHandCursor: true });
      frame.on(Phaser.Input.Events.GAMEOBJECT_POINTER_OVER, () => {
        handlers.onFocus(i);
      });
      frame.on(Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN, () => {
        handlers.onPick(i);
      });
      const top = CARD.y - CARD.height / 2;
      createAvatar(scene, c, x, top + 110).root.setScale(0.7);
      scene.add.text(x, top + 215, statsText(c), { ...textStyle(20), align: "center" }).setOrigin(0.5, 0);
      scene.add.text(x, top + 285, `「${c.skill.name}」`, textStyle(20, "#ffd866")).setOrigin(0.5, 0);
      scene.add
        .text(x, top + 318, wrapByChars(c.skill.description, 13), { ...textStyle(16, "#c8d0e0"), align: "center" })
        .setOrigin(0.5, 0);
      const badge = scene.add.text(x, top + 14, "", textStyle(18, "#ffd866")).setOrigin(0.5, 0);
      return { frame, badge };
    });

    this.summary = scene.add.text(GAME_WIDTH / 2, 585, "", textStyle(26)).setOrigin(0.5);
    this.backButton = createButton(scene, GAME_WIDTH / 2 - 130, 645, "戻る (K)", handlers.onBack);
    createButton(scene, GAME_WIDTH / 2 + 130, 645, "おまかせ (R)", handlers.onRandom);
    scene.add
      .text(
        GAME_WIDTH / 2,
        700,
        "クリックで決定    ／    A / D : 選ぶ    J : 決定    K : 戻る    R : おまかせ",
        textStyle(18, "#9aa4b8"),
      )
      .setOrigin(0.5);
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
    this.stepText.setText(picking ? "あなたのキャラを選んでください" : "相手（CPU）のキャラを選んでください");
    this.summary.setText(
      picking ? `あなた: ${focusName}    VS    CPU: ？` : `あなた: ${state.player.name}    VS    CPU: ${focusName}`,
    );
    this.backButton.setVisible(!picking);
    this.cards.forEach((card, i) => {
      const isFocus = i === state.cursor;
      card.frame.setStrokeStyle(isFocus ? 5 : 2, isFocus ? STEP_COLOR[state._tag] : 0x596275);
      card.frame.setFillStyle(isFocus ? 0x262c3a : 0x1b1f2a);
      card.badge.setText(this.roster[i]?.id === playerId ? "▼ あなた" : "");
    });
  }
}
