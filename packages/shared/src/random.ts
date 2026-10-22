import { Array as Arr, Context, Effect, Layer, Option } from "effect";

/**
 * 乱数源。ゲームロジックはこのサービス経由でのみ乱数を得る。
 * 本番は Phaser.Math.RND を包んだ Layer（src/game/phaserRandom.ts）、
 * テストはシード固定のスタブ（seededRandomLayer）を注入する。
 */
export interface RandomSource {
  /** [0, 1) の一様乱数。 */
  readonly frac: () => number;
}

export class RandomService extends Context.Tag("RandomService")<
  RandomService,
  {
    /** min 以上 max 以下の整数。 */
    readonly integerInRange: (min: number, max: number) => Effect.Effect<number>;
    /** 非空配列から 1 要素を一様に選ぶ。 */
    readonly pick: <A>(items: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<A>;
    /** 確率 probability（0〜1）で true。 */
    readonly chance: (probability: number) => Effect.Effect<boolean>;
  }
>() {}

/** 任意の [0,1) 乱数源から RandomService を作る。 */
export const randomServiceFrom = (source: RandomSource): Context.Tag.Service<RandomService> => {
  const integerInRange = (min: number, max: number): Effect.Effect<number> =>
    Effect.sync(() => min + Math.floor(source.frac() * (max - min + 1)));
  return {
    integerInRange,
    chance: (probability) => Effect.sync(() => source.frac() < probability),
    pick: <A>(items: Arr.NonEmptyReadonlyArray<A>) =>
      Effect.flatMap(integerInRange(0, items.length - 1), (i) =>
        Option.match(Arr.get(items, i), {
          onNone: () => Effect.dieMessage(`乱数インデックスが範囲外: ${String(i)} / ${String(items.length)}`),
          onSome: Effect.succeed,
        }),
      ),
  };
};

/** mulberry32。テストや Phaser 非依存の実行用のシード固定乱数。 */
export const mulberry32 = (seed: number): RandomSource => {
  let a = seed >>> 0;
  return {
    frac: () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
};

export const seededRandomLayer = (seed: number): Layer.Layer<RandomService> =>
  Layer.sync(RandomService, () => randomServiceFrom(mulberry32(seed)));

/**
 * 指定した値を順に返すスタブ（確率判定を狙って成立・不成立させるテスト用）。
 * 使い切ったら fallbackSeed の mulberry32 に切り替える。
 */
export const scriptedRandomLayer = (values: readonly number[], fallbackSeed = 1): Layer.Layer<RandomService> =>
  Layer.sync(RandomService, () => {
    const fallback = mulberry32(fallbackSeed);
    let i = 0;
    return randomServiceFrom({
      frac: () => {
        const v = values[i];
        i += 1;
        return v ?? fallback.frac();
      },
    });
  });

/**
 * 常に同じ値を返すスタブ。frac = 0 なら確率判定はすべて成立し、配列からは先頭を選ぶ。
 * frac = 0.999 ならすべて不成立で、配列からは末尾を選ぶ。
 */
export const constantRandomLayer = (frac: number): Layer.Layer<RandomService> =>
  Layer.succeed(RandomService, randomServiceFrom({ frac: () => frac }));
