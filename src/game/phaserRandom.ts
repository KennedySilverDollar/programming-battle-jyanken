import { Layer } from "effect";
import * as Phaser from "phaser";
import { randomServiceFrom, RandomService } from "../core/random";

/**
 * Phaser.Math.RND を包んだ本番用 RandomService。
 * Phaser.Math.RND に触れるのはこのファイルだけ。シードは sow で固定する。
 */
export const phaserRandomLayer = (seed: number): Layer.Layer<RandomService> =>
  Layer.sync(RandomService, () => {
    Phaser.Math.RND.sow([String(seed)]);
    return randomServiceFrom({ frac: () => Phaser.Math.RND.frac() });
  });
