import { Effect, Layer, Schema } from "effect";
import { AchievementStore } from "../core/achievements";
import { AchievementStorageError } from "../core/errors";

const KEY = "programming-battle-jyanken.achievements.v1";

/** 保存形式：解除済み実績 ID の JSON 配列。壊れていたら「何も解除していない」とみなす。 */
const Stored = Schema.parseJson(Schema.Array(Schema.String));

const storage = (): Effect.Effect<Storage, AchievementStorageError> =>
  Effect.try({
    try: () => window.localStorage,
    catch: (e) => new AchievementStorageError({ reason: `localStorage を使えません: ${String(e)}` }),
  });

const read: Effect.Effect<ReadonlySet<string>, AchievementStorageError> = Effect.gen(function* () {
  const ls = yield* storage();
  const raw = yield* Effect.try({
    try: () => ls.getItem(KEY),
    catch: (e) => new AchievementStorageError({ reason: String(e) }),
  });
  if (raw === null) return new Set<string>();
  const ids = yield* Schema.decodeUnknown(Stored)(raw).pipe(Effect.orElseSucceed((): readonly string[] => []));
  return new Set(ids);
});

const write = (ids: ReadonlySet<string>): Effect.Effect<void, AchievementStorageError> =>
  Effect.flatMap(storage(), (ls) =>
    Effect.try({
      try: () => {
        ls.setItem(KEY, JSON.stringify([...ids].sort()));
      },
      catch: (e) => new AchievementStorageError({ reason: `保存に失敗しました: ${String(e)}` }),
    }),
  );

/** ローカルストレージに永続化する AchievementStore。 */
export const localStorageAchievementStore: Layer.Layer<AchievementStore> = Layer.succeed(AchievementStore, {
  unlockedIds: read,
  unlock: (id) =>
    Effect.gen(function* () {
      const ids = yield* read;
      if (ids.has(id)) return false;
      yield* write(new Set([...ids, id]));
      return true;
    }),
});
