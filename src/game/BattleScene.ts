import { Cause, Effect, Exit, Fiber, Layer } from "effect";
import * as Phaser from "phaser";
import { randomCpuLayer } from "../core/ai";
import { playRound } from "../core/battle";
import type { RoundResult } from "../core/events";
import { BattleEvents, PlayerInput } from "../core/services";
import { initialGameState } from "../core/state";
import { battleView } from "../core/view";
import type { LaunchConfig } from "./launch";
import { phaserRandomLayer } from "./phaserRandom";
import { BattleUi } from "./ui";

/** 戦闘 Fiber 完了時に Scene の EventEmitter へ流すイベント名。 */
export const BATTLE_FINISHED = "battle-finished";

/**
 * Effect を実行するだけの薄いホスト。
 * - create() で戦闘プログラムを Fiber として起動（update() では何も実行しない）
 * - エンジン → UI は BattleEvents、UI → エンジンは PlayerInput（いずれも Effect.async で橋渡し）
 * - Fiber 完了は BATTLE_FINISHED イベントで通知
 */
export class BattleScene extends Phaser.Scene {
  private restarts = 0;
  private finished = false;

  constructor(private readonly config: LaunchConfig) {
    super("battle");
  }

  create(): void {
    this.finished = false;
    const { data, characters, seed } = this.config;
    const ui = new BattleUi(this, battleView(initialGameState(characters), "Player"));

    const bindings: readonly (readonly [string, () => void])[] = [
      [
        "keydown-A",
        () => {
          ui.moveCursor(-1);
        },
      ],
      [
        "keydown-D",
        () => {
          ui.moveCursor(1);
        },
      ],
      [
        "keydown-J",
        () => {
          ui.confirm();
        },
      ],
      [
        "keydown-R",
        () => {
          if (this.finished) {
            this.restarts += 1;
            this.scene.restart();
          }
        },
      ],
    ];
    const keyboard = this.input.keyboard;
    for (const [event, handler] of bindings) keyboard?.on(event, handler);

    const hostLayer = Layer.mergeAll(
      Layer.succeed(PlayerInput, {
        chooseMove: (view) =>
          Effect.async((resume) => {
            const cancel = ui.beginSelection(view, (move) => {
              resume(Effect.succeed(move));
            });
            return Effect.sync(cancel);
          }),
      }),
      Layer.succeed(BattleEvents, {
        publish: (event) =>
          Effect.async((resume: (effect: Effect.Effect<void>) => void) => {
            const cancel = ui.present(event, () => {
              resume(Effect.void);
            });
            return Effect.sync(cancel);
          }),
      }),
    );
    const env = Layer.provideMerge(randomCpuLayer, phaserRandomLayer(seed + this.restarts));
    const program = playRound({ balance: data.balance, characters }).pipe(Effect.provide(Layer.merge(hostLayer, env)));

    const fiber = Effect.runFork(program);
    const generation = this.restarts;
    fiber.addObserver((exit) => {
      // リスタートで中断された旧 Fiber の完了通知は無視する
      if (generation !== this.restarts) return;
      this.onFinished(exit, ui);
      this.events.emit(BATTLE_FINISHED, exit);
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const [event, handler] of bindings) keyboard?.off(event, handler);
      Effect.runFork(Fiber.interrupt(fiber));
    });
  }

  private onFinished(exit: Exit.Exit<RoundResult>, ui: BattleUi): void {
    this.finished = true;
    if (Exit.isFailure(exit) && !Exit.isInterrupted(exit)) {
      console.error(Cause.pretty(exit.cause));
      ui.showFatal(Cause.pretty(exit.cause));
    }
  }
}
