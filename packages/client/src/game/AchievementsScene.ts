import { Cause, Effect, Exit } from "effect";
import * as Phaser from "phaser";
import { type Achievement, listAchievements } from "@pbj/shared/achievements";
import { createBackdrop, fadeIn, fadeOutThen, popIn } from "./fx";
import type { GameSession } from "./session";
import { bindKeys, createButton, GAME_WIDTH, textStyle, wrapByChars } from "./widgets";

/**
 * 実績画面。解除前は「???」とヒント 1 行だけ、解除後は開発現場での実問題を読める。
 * 解除状態は AchievementStore（ローカルストレージ）から読む。
 */
export class AchievementsScene extends Phaser.Scene {
  constructor(private readonly session: GameSession) {
    super("achievements");
  }

  create(): void {
    fadeIn(this);
    createBackdrop(this, [0xffd866, 0x7fdbff]);
    this.add
      .text(GAME_WIDTH / 2, 44, "🏆 実績", { ...textStyle(36), fontStyle: "bold" })
      .setOrigin(0.5)
      .setStroke("#0b0d12", 6);
    const count = this.add.text(GAME_WIDTH / 2, 88, "", textStyle(20, "#c8d0e0")).setOrigin(0.5);

    const back = (): void => {
      fadeOutThen(this, () => this.scene.start("select"));
    };
    createButton(this, GAME_WIDTH / 2, 670, "戻る (K)", back);
    bindKeys(this, [
      ["keydown-K", back],
      ["keydown-ESC", back],
      ["keydown-Q", back],
    ]);

    // 読み込みは Fiber として起動し、完了したら描画する（update() では何もしない）
    const program = listAchievements(this.session.data.achievements).pipe(
      Effect.provide(this.session.achievementStore),
    );
    Effect.runFork(program).addObserver((exit) => {
      if (!this.sys.isActive()) return;
      Exit.match(exit, {
        onFailure: (cause) => {
          count.setText(`実績を読み込めませんでした：${Cause.pretty(cause).slice(0, 80)}`);
        },
        onSuccess: (list) => {
          count.setText(`解除 ${String(list.filter((a) => a.unlocked).length)} / ${String(list.length)}`);
          list.forEach((a, i) => {
            this.renderRow(a, i);
          });
        },
      });
    });
  }

  private renderRow(a: Achievement, i: number): void {
    const y = 128 + i * 104;
    const bg = this.add
      .rectangle(0, 0, GAME_WIDTH - 160, 94, a.unlocked ? 0x1f2533 : 0x14171f, 0.92)
      .setStrokeStyle(2, a.unlocked ? 0xffd866 : 0x3b4252);
    const left = -(GAME_WIDTH - 160) / 2 + 24;
    const title = this.add
      .text(left, -30, a.unlocked ? `🏆 ${a.title}` : "??? ", {
        ...textStyle(22, a.unlocked ? "#ffd866" : "#9aa4b8"),
        fontStyle: "bold",
      })
      .setOrigin(0, 0);
    const body = this.add
      .text(left, 2, a.unlocked ? wrapByChars(a.detail, 62) : `ヒント：${a.hint}`, {
        ...textStyle(16, a.unlocked ? "#e5e9f0" : "#7b8496"),
        lineSpacing: 3,
      })
      .setOrigin(0, 0);
    const row = this.add.container(GAME_WIDTH / 2, y + 47, [bg, title, body]);
    popIn(this, row, i * 70, 0.9);
  }
}
