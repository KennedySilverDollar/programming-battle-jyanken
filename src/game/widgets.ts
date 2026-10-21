import * as Phaser from "phaser";

/** 16:9 固定の論理解像度。 */
export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

const FONT = "sans-serif";

export const textStyle = (size: number, color = "#ffffff"): Phaser.Types.GameObjects.Text.TextStyle => ({
  fontFamily: FONT,
  fontSize: `${String(size)}px`,
  color,
});

/** クリック可能なボタン。非表示の間は反応しない。 */
export const createButton = (
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  onClick: () => void,
  width = 220,
): Phaser.GameObjects.Container => {
  const bg = scene.add
    .rectangle(0, 0, width, 56, 0x3b4252)
    .setStrokeStyle(3, 0xffd866)
    .setInteractive({ useHandCursor: true });
  bg.on(Phaser.Input.Events.GAMEOBJECT_POINTER_OVER, () => bg.setFillStyle(0x4c566a));
  bg.on(Phaser.Input.Events.GAMEOBJECT_POINTER_OUT, () => bg.setFillStyle(0x3b4252));
  const label = scene.add.text(0, 0, text, textStyle(24)).setOrigin(0.5);
  const container = scene.add.container(x, y, [bg, label]);
  // 非表示のボタンは押せない（表示前のクリックで誤作動させない）
  bg.on(Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN, () => {
    if (container.visible) onClick();
  });
  return container;
};

/** 空白で区切られない日本語向けに、文字数で折り返す。 */
export const wrapByChars = (text: string, perLine: number): string => {
  const chars = Array.from(text);
  const lines: string[] = [];
  for (let i = 0; i < chars.length; i += perLine) lines.push(chars.slice(i, i + perLine).join(""));
  return lines.join("\n");
};

/** Scene ごとのキー操作を登録し、Scene 終了時に解除する。 */
export const bindKeys = (scene: Phaser.Scene, bindings: readonly (readonly [string, () => void])[]): void => {
  const keyboard = scene.input.keyboard;
  if (keyboard === null) return;
  for (const [event, handler] of bindings) keyboard.on(event, handler);
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
    for (const [event, handler] of bindings) keyboard.off(event, handler);
  });
};
