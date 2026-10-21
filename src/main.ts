import { Cause, Effect, Exit } from "effect";
import * as Phaser from "phaser";
import { BattleScene } from "./game/BattleScene";
import { loadLaunchConfig } from "./game/launch";
import { SelectScene } from "./game/SelectScene";
import { GameSession } from "./game/session";
import { GAME_HEIGHT, GAME_WIDTH } from "./game/widgets";

const showFatal = (message: string): void => {
  const pre = document.createElement("pre");
  pre.style.cssText = "color:#ff8080;padding:24px;white-space:pre-wrap;font:14px monospace";
  pre.textContent = message;
  document.body.replaceChildren(pre);
};

// 起動時にデータをパースし、不正なら型付きエラーとしてここで止める
void Effect.runPromiseExit(loadLaunchConfig(window.location.search)).then((exit) => {
  Exit.match(exit, {
    onFailure: (cause) => {
      console.error(Cause.pretty(cause));
      showFatal(`起動に失敗しました\n\n${Cause.pretty(cause)}`);
    },
    onSuccess: (config) => {
      const session = new GameSession(config.data, config.seed, config.preset);
      new Phaser.Game({
        type: Phaser.AUTO,
        parent: "game",
        backgroundColor: "#11141c",
        width: GAME_WIDTH,
        height: GAME_HEIGHT,
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
        // 先頭の Scene（キャラ選択）から始まる
        scene: [new SelectScene(session), new BattleScene(session)],
      });
    },
  });
});
