import * as Phaser from "phaser";
import type { CharacterDef } from "../core/characters";
import { addGlow, desaturate, reducedMotion } from "./fx";

/** 画面上の向き。+1 は右（相手が右にいる）、-1 は左。 */
export type Facing = 1 | -1;

/**
 * キャラクターの見た目。今は色付き矩形＋言語名の仮置きで、
 * logoKey のテクスチャがロードされていれば画像に自動で差し替わる。
 * 動きはすべてこのインターフェース越しに付けるので、画像に差し替えても演出はそのまま使える。
 */
export interface FighterAvatar {
  readonly root: Phaser.GameObjects.Container;
  setActive(active: boolean): void;
  /** 画面外から滑り込む。 */
  enter(delay: number): void;
  /** 待機中の呼吸（上下にゆっくり揺れる）。 */
  startIdle(): void;
  /** 相手に向かって踏み込む。 */
  lunge(): void;
  /** 被弾：白く光ってのけぞる。 */
  hit(): void;
  /** スキル発動などで一時的に光る。 */
  pulse(color: number, ms: number): void;
  /** 勝利：跳ねる。 */
  celebrate(): void;
  /** 敗北：色を失って崩れる。 */
  defeat(): void;
}

export const AVATAR_SIZE = { width: 220, height: 240 } satisfies { width: number; height: number };

interface Parts {
  /** 実際の見た目（矩形 or 画像）。 */
  readonly visuals: readonly Phaser.GameObjects.GameObject[];
  readonly setActive: (active: boolean) => void;
}

const rectParts = (scene: Phaser.Scene, def: CharacterDef): Parts => {
  const body = scene.add
    .rectangle(0, 0, AVATAR_SIZE.width, AVATAR_SIZE.height, def.placeholder.color)
    .setStrokeStyle(4, 0xffffff, 0.25);
  // 上部に光沢を重ねて立体感を出す
  const sheen = scene.add.rectangle(
    0,
    -AVATAR_SIZE.height / 4,
    AVATAR_SIZE.width - 8,
    AVATAR_SIZE.height / 2 - 4,
    0xffffff,
    0.08,
  );
  const emoji = scene.add.text(0, -40, def.placeholder.emoji, { fontSize: "64px" }).setOrigin(0.5);
  const name = scene.add
    .text(0, 60, def.name, { fontFamily: "sans-serif", fontSize: "32px", fontStyle: "bold", color: "#ffffff" })
    .setOrigin(0.5)
    .setStroke("#000000", 5);
  return {
    visuals: [body, sheen, emoji, name],
    setActive: (active) => body.setStrokeStyle(4, 0xffffff, active ? 1 : 0.25),
  };
};

const imageParts = (scene: Phaser.Scene, def: CharacterDef): Parts => {
  const image = scene.add.image(0, 0, def.logoKey).setDisplaySize(AVATAR_SIZE.width, AVATAR_SIZE.height);
  return { visuals: [image], setActive: (active) => image.setAlpha(active ? 1 : 0.85) };
};

/**
 * root（配置位置・固定）→ rig（動き）→ 見た目＋白フラッシュ用オーバーレイ、の 3 層。
 * 動きは rig の相対座標だけを動かすので、配置は崩れない。
 */
export const createAvatar = (
  scene: Phaser.Scene,
  def: CharacterDef,
  x: number,
  y: number,
  facing: Facing = 1,
): FighterAvatar => {
  const parts = scene.textures.exists(def.logoKey) ? imageParts(scene, def) : rectParts(scene, def);
  const overlay = scene.add.rectangle(0, 0, AVATAR_SIZE.width, AVATAR_SIZE.height, 0xffffff, 1).setAlpha(0);
  const rig = scene.add.container(0, 0, [...parts.visuals, overlay]);
  const shadow = scene.add.ellipse(0, AVATAR_SIZE.height / 2 + 18, AVATAR_SIZE.width * 0.8, 22, 0x000000, 0.35);
  const root = scene.add.container(x, y, [shadow, rig]);
  // 光彩は rig の最背面に置き、踏み込みやジャンプに追従させる
  const glow = addGlow(scene, rig, AVATAR_SIZE.width, AVATAR_SIZE.height, def.placeholder.color);
  const calm = reducedMotion();
  let idle: Phaser.Tweens.Tween | undefined;

  const stopIdle = (): void => {
    idle?.stop();
    idle = undefined;
    rig.y = 0;
  };

  return {
    root,
    setActive: parts.setActive,
    enter: (delay) => {
      const fromX = -facing * 420;
      rig.setX(fromX).setAlpha(0);
      shadow.setAlpha(0);
      scene.tweens.add({ targets: rig, x: 0, alpha: 1, duration: 520, delay, ease: "Cubic.easeOut" });
      scene.tweens.add({ targets: shadow, alpha: 0.35, duration: 520, delay });
    },
    startIdle: () => {
      if (calm || idle !== undefined) return;
      idle = scene.tweens.add({
        targets: rig,
        y: -7,
        duration: 1400,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    },
    lunge: () => {
      scene.tweens.add({ targets: rig, x: facing * 70, duration: 110, yoyo: true, ease: "Quad.easeOut" });
    },
    hit: () => {
      overlay.setAlpha(0.9);
      scene.tweens.add({ targets: overlay, alpha: 0, duration: 260, ease: "Quad.easeOut" });
      if (calm) return;
      scene.tweens.add({
        targets: rig,
        x: -facing * 36,
        angle: -facing * 6,
        duration: 90,
        yoyo: true,
        ease: "Quad.easeOut",
      });
    },
    pulse: (color, ms) => {
      glow.setColor(color);
      scene.tweens.killTweensOf(glow.image);
      glow.image.setAlpha(0);
      scene.tweens.add({ targets: glow.image, alpha: 1, duration: ms / 4, yoyo: true, repeat: 1 });
    },
    celebrate: () => {
      stopIdle();
      scene.tweens.add({
        targets: rig,
        y: -46,
        duration: 260,
        yoyo: true,
        repeat: calm ? 0 : 2,
        ease: "Quad.easeOut",
      });
      glow.setColor(0xffd866);
      glow.set(true);
    },
    defeat: () => {
      stopIdle();
      desaturate(root);
      scene.tweens.add({ targets: rig, angle: -facing * 8, y: 14, alpha: 0.6, duration: 600, ease: "Cubic.easeOut" });
    },
  };
};
