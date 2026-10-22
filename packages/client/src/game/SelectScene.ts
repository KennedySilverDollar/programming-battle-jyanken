import { Effect, Option } from "effect";
import * as Phaser from "phaser";
import { mulberry32, randomServiceFrom } from "@pbj/shared/random";
import { preloadLogos } from "./avatar";
import { fadeIn, fadeOutThen } from "./fx";
import { SelectUi } from "./select";
import { back, confirm, focusIndex, initialSelect, moveCursor, type SelectState } from "./selectState";
import type { GameSession } from "./session";
import { bindKeys } from "./widgets";

/** キャラクター選択。決定したら GameSession に対戦カードを書き込み、戦闘 Scene へ移る。 */
export class SelectScene extends Phaser.Scene {
  constructor(private readonly session: GameSession) {
    super("select");
  }

  preload(): void {
    // 公式ロゴ（public/logos）。読み込めなくても絵文字で代用して続行する
    preloadLogos(this, this.session.roster);
  }

  create(): void {
    if (this.session.consumeAutoStart()) {
      this.scene.start("battle");
      return;
    }
    const roster = this.session.roster;
    fadeIn(this);

    // 前回の自分のキャラにカーソルを合わせて始める
    const lastIndex = Option.match(this.session.currentMatchup(), {
      onNone: () => 0,
      onSome: (m) =>
        Math.max(
          0,
          roster.findIndex((c) => c.id === m.Player.id),
        ),
    });
    let state: SelectState = initialSelect(lastIndex);

    const update = (next: SelectState): void => {
      // 決定後（VS 演出中）の入力で演出・遷移を二重に起こさない
      if (state._tag === "Done") return;
      state = next;
      switch (state._tag) {
        case "PickPlayer":
        case "PickCpu":
          ui.render(state);
          return;
        case "Done": {
          const { matchup } = state;
          this.session.setMatchup(matchup);
          // VS スプラッシュ → フェードアウト → 戦闘へ（Done 以降の入力は状態遷移側で無視される）
          ui.playVersus(matchup, () => {
            fadeOutThen(this, () => this.scene.start("battle"));
          });
          return;
        }
      }
    };

    // おまかせ：RandomService 経由で選ぶ（シードは試合用とは別に払い出す）
    const random = randomServiceFrom(mulberry32(this.session.nextSeed()));
    const pickRandom = (): void => {
      const index = Effect.runSync(random.integerInRange(0, roster.length - 1));
      update(confirm(focusIndex(state, index, roster), roster));
    };

    const openAchievements = (): void => {
      if (state._tag === "Done") return;
      fadeOutThen(this, () => this.scene.start("achievements"));
    };

    const ui = new SelectUi(this, roster, {
      onFocus: (i) => {
        update(focusIndex(state, i, roster));
      },
      onPick: (i) => {
        update(confirm(focusIndex(state, i, roster), roster));
      },
      onBack: () => {
        update(back(state, roster));
      },
      onRandom: pickRandom,
      onAchievements: openAchievements,
    });
    ui.render(state);

    bindKeys(this, [
      [
        "keydown-A",
        () => {
          update(moveCursor(state, -1, roster));
        },
      ],
      [
        "keydown-D",
        () => {
          update(moveCursor(state, 1, roster));
        },
      ],
      [
        "keydown-J",
        () => {
          update(confirm(state, roster));
        },
      ],
      [
        "keydown-K",
        () => {
          update(back(state, roster));
        },
      ],
      ["keydown-R", pickRandom],
      ["keydown-Q", openAchievements],
    ]);
  }
}
