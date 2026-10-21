import * as Phaser from "phaser";
import type { CharacterDef } from "../core/characters";

/**
 * キャラクターの見た目。今は色付き矩形＋言語名の仮置きで、
 * logoKey のテクスチャがロードされていれば画像に自動で差し替わる。
 */
export interface FighterAvatar {
  readonly root: Phaser.GameObjects.Container;
  setActive(active: boolean): void;
}

export const AVATAR_SIZE = { width: 220, height: 240 } satisfies { width: number; height: number };

const rectAvatar = (scene: Phaser.Scene, def: CharacterDef, x: number, y: number): FighterAvatar => {
  const body = scene.add
    .rectangle(0, 0, AVATAR_SIZE.width, AVATAR_SIZE.height, def.placeholder.color)
    .setStrokeStyle(4, 0xffffff, 0.25);
  const emoji = scene.add.text(0, -40, def.placeholder.emoji, { fontSize: "64px" }).setOrigin(0.5);
  const name = scene.add
    .text(0, 60, def.name, { fontFamily: "sans-serif", fontSize: "32px", fontStyle: "bold", color: "#ffffff" })
    .setOrigin(0.5)
    .setStroke("#000000", 5);
  const root = scene.add.container(x, y, [body, emoji, name]);
  return {
    root,
    setActive: (active) => body.setStrokeStyle(4, 0xffffff, active ? 1 : 0.25),
  };
};

const imageAvatar = (scene: Phaser.Scene, def: CharacterDef, x: number, y: number): FighterAvatar => {
  const image = scene.add.image(0, 0, def.logoKey).setDisplaySize(AVATAR_SIZE.width, AVATAR_SIZE.height);
  const root = scene.add.container(x, y, [image]);
  return {
    root,
    setActive: (active) => image.setAlpha(active ? 1 : 0.85),
  };
};

export const createAvatar = (scene: Phaser.Scene, def: CharacterDef, x: number, y: number): FighterAvatar =>
  scene.textures.exists(def.logoKey) ? imageAvatar(scene, def, x, y) : rectAvatar(scene, def, x, y);
