import { Effect, Option } from "effect";
import * as Phaser from "phaser";
import { mulberry32, randomServiceFrom } from "../core/random";
import { SelectUi } from "./select";
import { back, confirm, focusIndex, initialSelect, moveCursor, type SelectState } from "./selectState";
import type { GameSession } from "./session";
import { bindKeys } from "./widgets";

/** キャラクター選択。決定したら GameSession に対戦カードを書き込み、戦闘 Scene へ移る。 */
export class SelectScene extends Phaser.Scene {
  constructor(private readonly session: GameSession) {
    super("select");
  }

  create(): void {
    if (this.session.consumeAutoStart()) {
      this.scene.start("battle");
      return;
    }
    const roster = this.session.roster;

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
      state = next;
      switch (state._tag) {
        case "PickPlayer":
        case "PickCpu":
          ui.render(state);
          return;
        case "Done":
          this.session.setMatchup(state.matchup);
          this.scene.start("battle");
          return;
      }
    };

    // おまかせ：RandomService 経由で選ぶ（シードは試合用とは別に払い出す）
    const random = randomServiceFrom(mulberry32(this.session.nextSeed()));
    const pickRandom = (): void => {
      const index = Effect.runSync(random.integerInRange(0, roster.length - 1));
      update(confirm(focusIndex(state, index, roster), roster));
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
    ]);
  }
}
