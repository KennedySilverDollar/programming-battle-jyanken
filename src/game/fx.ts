import * as Phaser from "phaser";
import { GAME_HEIGHT, GAME_WIDTH, textStyle } from "./widgets";

/**
 * 演出用の共通部品。すべて表示だけに作用し、ゲーム状態には触れない。
 *
 * 性能方針：背景・ビネット・発光は Canvas 2D で一度だけテクスチャに焼き込み、
 * 毎フレームはただの画像として描く。WebGL の Filters は、オブジェクトに付けるだけで
 * 毎フレーム描画パスが増え、ソフトウェア描画（GPU なしの WebView など）では数 fps まで
 * 落ちたため、常駐させない。使うのは敗北時のグレースケール（1 体・試合終了後のみ）だけ。
 */

/** OS の「視差効果を減らす」設定。揺れ・点滅・常時アニメーションを抑える。 */
export const reducedMotion = (): boolean => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

const TEX = { dot: "fx-dot", spark: "fx-spark", confetti: "fx-confetti" } satisfies Record<string, string>;

/** パーティクル用のテクスチャをコードで生成する（画像ファイル不要）。 */
const ensureTextures = (scene: Phaser.Scene): void => {
  const make = (key: string, w: number, h: number, draw: (g: Phaser.GameObjects.Graphics) => void): void => {
    if (scene.textures.exists(key)) return;
    const g = scene.add.graphics();
    draw(g);
    g.generateTexture(key, w, h);
    g.destroy();
  };
  make(TEX.dot, 32, 32, (g) => {
    // 中心ほど明るい柔らかい点
    for (let r = 16; r > 0; r -= 2) g.fillStyle(0xffffff, 0.08 + (1 - r / 16) * 0.5).fillCircle(16, 16, r);
  });
  make(TEX.spark, 24, 6, (g) => g.fillStyle(0xffffff, 1).fillRoundedRect(0, 0, 24, 6, 3));
  make(TEX.confetti, 10, 16, (g) => g.fillStyle(0xffffff, 1).fillRect(0, 0, 10, 16));
};

// ---------------------------------------------------------------------------
// 背景・画面全体
// ---------------------------------------------------------------------------

const CODE_GLYPHS = ["{ }", "=>", ";", "λ", "()", "</>", "&&", "::", "[]", "#", "0", "1", "++", "!="];

// ---------------------------------------------------------------------------
// 描画品質の自動調整
// ---------------------------------------------------------------------------

const LOW_QUALITY_KEY = "fx-low-quality";
const FIXED_QUALITY_KEY = "fx-quality-fixed";
/** これを下回ったら背景の装飾を外す。 */
const MIN_FPS = 28;

/** 低品質モード（GPU が無い環境など）。一度入ったらそのゲーム中は維持する。 */
export const isLowQuality = (scene: Phaser.Scene): boolean => scene.registry.get(LOW_QUALITY_KEY) === true;

/** 描画品質の指定。auto は起動直後の実測 fps で決める。 */
export type Quality = "auto" | "high" | "low";

export const setQuality = (registry: Phaser.Data.DataManager, quality: Quality): void => {
  registry.set(FIXED_QUALITY_KEY, quality !== "auto");
  registry.set(LOW_QUALITY_KEY, quality === "low");
};

/**
 * 起動直後の実測 fps が低ければ、重い装飾（全画面の背景画像・漂う記号）を外す。
 * fps が低いとゲーム内時間も遅れるので、Phaser の時計ではなく実時間（loop.time）で測る。
 */
const watchFrameRate = (scene: Phaser.Scene, decorations: readonly Phaser.GameObjects.GameObject[]): void => {
  if (isLowQuality(scene) || scene.registry.get(FIXED_QUALITY_KEY) === true) return;
  const loop = scene.game.loop;
  const warmup = loop.time + 500;
  let start: { frame: number; time: number } | undefined;
  const check = (): void => {
    if (loop.time < warmup) return;
    if (start === undefined) {
      start = { frame: loop.frame, time: loop.time };
      return;
    }
    const elapsed = loop.time - start.time;
    if (elapsed < 1500) return;
    scene.events.off(Phaser.Scenes.Events.POST_UPDATE, check);
    const fps = ((loop.frame - start.frame) * 1000) / elapsed;
    if (fps >= MIN_FPS) return;
    scene.registry.set(LOW_QUALITY_KEY, true);
    for (const d of decorations) {
      scene.tweens.killTweensOf(d);
      d.destroy();
    }
  };
  scene.events.on(Phaser.Scenes.Events.POST_UPDATE, check);
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
    scene.events.off(Phaser.Scenes.Events.POST_UPDATE, check);
  });
};

/** Canvas 2D で描いたテクスチャを一度だけ作る。 */
const canvasTexture = (
  scene: Phaser.Scene,
  key: string,
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): string => {
  if (scene.textures.exists(key)) return key;
  const tex = scene.textures.createCanvas(key, w, h);
  if (tex === null) return key;
  draw(tex.getContext());
  tex.refresh();
  return key;
};

const css = (color: number, alpha = 1): string => {
  const c = Phaser.Display.Color.IntegerToColor(color);
  return `rgba(${String(c.red)}, ${String(c.green)}, ${String(c.blue)}, ${String(alpha)})`;
};

/**
 * 背景：2 色のグラデーション＋グリッド＋ビネットを 1 枚に焼き込み、
 * その上に下から漂うコード記号と光の粒を流す。accents はキャラクターの色（左・右）。
 */
export const createBackdrop = (scene: Phaser.Scene, accents: readonly [number, number]): void => {
  ensureTextures(scene);
  const [left, right] = accents;
  const key = canvasTexture(
    scene,
    `fx-bg-${left.toString(16)}-${right.toString(16)}`,
    GAME_WIDTH,
    GAME_HEIGHT,
    (ctx) => {
      const horizontal = ctx.createLinearGradient(0, 0, GAME_WIDTH, 0);
      horizontal.addColorStop(0, css(left, 0.28));
      horizontal.addColorStop(0.5, "rgba(11, 13, 18, 0)");
      horizontal.addColorStop(1, css(right, 0.28));
      ctx.fillStyle = "#0b0d12";
      ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
      ctx.fillStyle = horizontal;
      ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
      // 細いグリッド線（奥行き感）
      ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
      ctx.lineWidth = 1;
      for (let x = 0.5; x <= GAME_WIDTH; x += 64) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, GAME_HEIGHT);
        ctx.stroke();
      }
      for (let y = 0.5; y <= GAME_HEIGHT; y += 64) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(GAME_WIDTH, y);
        ctx.stroke();
      }
      // ビネット（周辺減光）
      const vignette = ctx.createRadialGradient(
        GAME_WIDTH / 2,
        GAME_HEIGHT / 2,
        GAME_HEIGHT * 0.35,
        GAME_WIDTH / 2,
        GAME_HEIGHT / 2,
        GAME_WIDTH * 0.75,
      );
      vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
      vignette.addColorStop(1, "rgba(0, 0, 0, 0.7)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    },
  );
  const low = isLowQuality(scene);
  const decorations: Phaser.GameObjects.GameObject[] = [];
  if (!low) decorations.push(scene.add.image(0, 0, key).setOrigin(0, 0).setDepth(-100));

  const calm = reducedMotion();
  scene.add
    .particles(0, 0, TEX.dot, {
      x: { min: 0, max: GAME_WIDTH },
      y: GAME_HEIGHT + 20,
      speedY: { min: -18, max: -45 },
      speedX: { min: -6, max: 6 },
      lifespan: 16000,
      scale: { min: 0.2, max: 0.7 },
      alpha: { start: 0.35, end: 0 },
      tint: [left, right, 0xffffff],
      frequency: calm || low ? 1200 : 400,
      blendMode: Phaser.BlendModes.ADD,
    })
    .setDepth(-98);

  if (!calm && !low) {
    CODE_GLYPHS.forEach((glyph, i) => {
      const x = ((i + 0.5) / CODE_GLYPHS.length) * GAME_WIDTH;
      const t = scene.add
        .text(x, GAME_HEIGHT + 40, glyph, { ...textStyle(18 + (i % 3) * 8, "#ffffff"), fontFamily: "monospace" })
        .setOrigin(0.5)
        .setAlpha(0)
        .setDepth(-97);
      decorations.push(t);
      scene.tweens.add({
        targets: t,
        y: -40,
        x: x + (i % 2 === 0 ? 40 : -40),
        alpha: { from: 0.12, to: 0 },
        duration: 14000 + (i % 5) * 2500,
        delay: i * 900,
        repeat: -1,
      });
    });
  }
  watchFrameRate(scene, decorations);
};

/** Scene の入り口でフェードイン。 */
export const fadeIn = (scene: Phaser.Scene, ms = 280): void => {
  const cam = scene.cameras.main;
  // 完了後も「透明な全画面矩形」を毎フレーム描き続けるので、終わったら効果を外す
  cam.once(Phaser.Cameras.Scene2D.Events.FADE_IN_COMPLETE, () => {
    cam.fadeEffect.reset();
  });
  cam.fadeIn(ms, 6, 8, 12);
};

/** フェードアウトしてから action（Scene 遷移など）を実行する。二重実行はしない。 */
export const fadeOutThen = (scene: Phaser.Scene, action: () => void, ms = 260): void => {
  const cam = scene.cameras.main;
  if (cam.fadeEffect.isRunning) return;
  cam.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, action);
  cam.fadeOut(ms, 6, 8, 12);
};

export const shake = (scene: Phaser.Scene, intensity = 0.008, ms = 220): void => {
  if (reducedMotion()) return;
  scene.cameras.main.shake(ms, intensity);
};

export const flash = (scene: Phaser.Scene, color = 0xffffff, ms = 120): void => {
  if (reducedMotion()) return;
  const c = Phaser.Display.Color.IntegerToColor(color);
  scene.cameras.main.flash(ms, c.red, c.green, c.blue);
};

// ---------------------------------------------------------------------------
// 個別のオブジェクト
// ---------------------------------------------------------------------------

type Scalable = Phaser.GameObjects.GameObject &
  Phaser.GameObjects.Components.Transform & { alpha: number; setAlpha(value: number): unknown };

/** ポンと出現（拡大しながらフェードイン）。 */
export const popIn = (scene: Phaser.Scene, target: Scalable, delay = 0, from = 0.6): void => {
  const scale = target.scale;
  target.setScale(scale * from);
  target.setAlpha(0);
  scene.tweens.add({ targets: target, scale, alpha: 1, duration: 260, delay, ease: "Back.easeOut" });
};

/** 一瞬大きくして戻す（強調）。 */
export const punch = (scene: Phaser.Scene, target: Scalable, amount = 1.25, ms = 160): void => {
  const scale = target.scale;
  scene.tweens.add({ targets: target, scale: scale * amount, duration: ms, yoyo: true, ease: "Quad.easeOut" });
};

/** 浮き上がって消える文字（ダメージ数値など）。 */
export const floatText = (scene: Phaser.Scene, x: number, y: number, text: string, color: string, size = 44): void => {
  const t = scene.add
    .text(x, y, text, { ...textStyle(size, color), fontStyle: "bold" })
    .setOrigin(0.5)
    .setStroke("#000000", 6)
    .setDepth(50);
  popIn(scene, t, 0, 0.4);
  scene.tweens.add({ targets: t, y: y - 70, alpha: 0, duration: 900, delay: 350, ease: "Cubic.easeIn" });
  scene.time.delayedCall(1300, () => {
    t.destroy();
  });
};

/** 火花の放射。 */
export const burst = (scene: Phaser.Scene, x: number, y: number, colors: readonly number[], count = 24): void => {
  ensureTextures(scene);
  const emitter = scene.add
    .particles(x, y, TEX.spark, {
      speed: { min: 180, max: 520 },
      angle: { min: 0, max: 360 },
      rotate: { onEmit: (p) => (p === undefined ? 0 : Phaser.Math.RadToDeg(Math.atan2(p.velocityY, p.velocityX))) },
      lifespan: { min: 250, max: 600 },
      scale: { start: 1, end: 0 },
      alpha: { start: 1, end: 0 },
      tint: [...colors],
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
    })
    .setDepth(40);
  emitter.explode(reducedMotion() ? Math.ceil(count / 3) : count);
  scene.time.delayedCall(900, () => {
    emitter.destroy();
  });
};

/** 紙吹雪（勝利演出）。 */
export const confetti = (scene: Phaser.Scene, x: number, colors: readonly number[]): void => {
  ensureTextures(scene);
  const emitter = scene.add
    .particles(x, -20, TEX.confetti, {
      x: { min: -260, max: 260 },
      speedY: { min: 120, max: 320 },
      speedX: { min: -80, max: 80 },
      gravityY: 160,
      rotate: { start: 0, end: 540 },
      lifespan: 3200,
      scale: { min: 0.6, max: 1.1 },
      alpha: { start: 1, end: 0.2 },
      tint: [...colors],
      frequency: 25,
      quantity: 2,
    })
    .setDepth(45);
  scene.time.delayedCall(reducedMotion() ? 300 : 1400, () => emitter.stop());
  scene.time.delayedCall(5000, () => {
    emitter.destroy();
  });
};

// ---------------------------------------------------------------------------
// 発光・グレースケール
// ---------------------------------------------------------------------------

const GLOW_PAD = 36;

/** 白い光彩（角丸矩形の縁がぼけて光る）のテクスチャ。色は tint で付ける。 */
const glowTexture = (scene: Phaser.Scene, w: number, h: number): string =>
  canvasTexture(scene, `fx-glow-${String(w)}x${String(h)}`, w + GLOW_PAD * 2, h + GLOW_PAD * 2, (ctx) => {
    ctx.shadowColor = "#ffffff";
    ctx.shadowBlur = 22;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = 6;
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.roundRect(GLOW_PAD, GLOW_PAD, w, h, 10);
      ctx.stroke();
    }
  });

/** 発光の操作口。 */
export interface Glow {
  readonly image: Phaser.GameObjects.Image;
  set(on: boolean): void;
  setColor(color: number): void;
}

/**
 * w×h の矩形を囲む光彩。container の最背面に置く（x, y は container 内の中心座標）。
 * 初期状態は消灯。
 */
export const addGlow = (
  scene: Phaser.Scene,
  container: Phaser.GameObjects.Container,
  w: number,
  h: number,
  color: number,
  x = 0,
  y = 0,
): Glow => {
  const image = scene.add
    .image(x, y, glowTexture(scene, w, h))
    .setTint(color)
    .setAlpha(0);
  image.setBlendMode(Phaser.BlendModes.ADD);
  container.addAt(image, 0);
  return {
    image,
    set: (on) => {
      scene.tweens.killTweensOf(image);
      scene.tweens.add({ targets: image, alpha: on ? 1 : 0, duration: 140 });
    },
    setColor: (c) => {
      image.setTint(c);
    },
  };
};

type Filterable = Phaser.GameObjects.GameObject & {
  enableFilters(): unknown;
  readonly filters: Phaser.Types.GameObjects.FiltersInternalExternal | null;
};

/** グレースケール化（敗北演出）。WebGL のみ。Canvas 描画では半透明で代用。 */
export const desaturate = (target: Filterable & { setAlpha(value: number): unknown }): void => {
  target.enableFilters();
  const matrix = target.filters?.internal.addColorMatrix();
  if (matrix === undefined) target.setAlpha(0.6);
  else matrix.colorMatrix.desaturate();
};
