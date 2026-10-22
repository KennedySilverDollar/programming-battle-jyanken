import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AchievementStore, listAchievements, memoryAchievementStore } from "../src/achievements";
import { gameData } from "./helpers";

describe("実績", () => {
  it("初回だけ true を返し、一覧に解除状態が反映される", () => {
    const program = Effect.gen(function* () {
      const store = yield* AchievementStore;
      const first = yield* store.unlock("segfault");
      const second = yield* store.unlock("segfault");
      const list = yield* listAchievements(gameData.achievements);
      return { first, second, list };
    }).pipe(Effect.provide(memoryAchievementStore()));
    const { first, second, list } = Effect.runSync(program);
    expect([first, second]).toEqual([true, false]);
    expect(list.filter((a) => a.unlocked).map((a) => a.achievementId)).toEqual(["segfault"]);
    // 解除前はヒントしか見せない想定なので、ヒントは必ずある
    for (const a of list) expect(a.hint.length).toBeGreaterThan(0);
  });

  it("隠れデメリットのあるキャラ 5 体それぞれに実績が 1 つずつ対応する", () => {
    const ids = gameData.roster.flatMap((c) => (c.hiddenTrait === null ? [] : [c.hiddenTrait.achievementId]));
    expect(new Set(ids)).toEqual(new Set(gameData.achievements.map((a) => a.achievementId)));
  });
});
