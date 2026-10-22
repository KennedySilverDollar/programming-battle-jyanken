import { Effect, Either, Option } from "effect";
import { describe, expect, it } from "vitest";
import { loadLaunchConfig } from "../src/game/launch";
import {
  back,
  confirm,
  focused,
  focusIndex,
  initialSelect,
  moveCursor,
  type SelectState,
} from "../src/game/selectState";
import { loadGameData } from "@pbj/shared/gameData";

const gameData = Effect.runSync(loadGameData());

const roster = gameData.roster;
const ids = (s: SelectState) => (s._tag === "Done" ? [s.matchup.Player.id, s.matchup.Cpu.id] : []);

describe("キャラ選択の状態遷移", () => {
  it("7 キャラすべてを自分・CPU の両方に選べる（ミラー含む 49 通り）", () => {
    const pairs = new Set<string>();
    roster.forEach((_, p) => {
      roster.forEach((_, c) => {
        const s = confirm(focusIndex(confirm(focusIndex(initialSelect(), p, roster), roster), c, roster), roster);
        pairs.add(ids(s).join("-"));
      });
    });
    expect(pairs.size).toBe(49);
    expect(pairs).toContain("haskell-haskell");
  });

  it("A/D のカーソル移動は端で折り返す", () => {
    const left = moveCursor(initialSelect(), -1, roster);
    expect(focused(left, roster)?.id).toBe("php");
    expect(focused(moveCursor(left, 1, roster), roster)?.id).toBe("java");
  });

  it("CPU 選択から戻ると、自分が選んでいたキャラにカーソルが戻る", () => {
    const pickedCpp = confirm(focusIndex(initialSelect(), 2, roster), roster);
    expect(pickedCpp._tag).toBe("PickCpu");
    const moved = moveCursor(pickedCpp, 1, roster);
    const s = back(moved, roster);
    expect(s).toEqual({ _tag: "PickPlayer", cursor: 2 });
    // 自分の選択画面で戻っても変化しない
    expect(back(s, roster)).toEqual(s);
  });

  it("決定後は入力を受け付けない", () => {
    const done = confirm(confirm(initialSelect(), roster), roster);
    expect(ids(done)).toEqual(["java", "java"]);
    expect(moveCursor(done, 1, roster)).toBe(done);
    expect(confirm(done, roster)).toBe(done);
    expect(back(done, roster)).toBe(done);
  });
});

describe("URL クエリ", () => {
  const run = (search: string) => Effect.runSync(Effect.either(loadLaunchConfig(search)));

  it("指定なしなら選択画面から（preset なし）", () => {
    const r = run("?seed=5");
    expect(Either.isRight(r) && Option.isNone(r.right.preset) && r.right.seed === 5).toBe(true);
  });

  it("player と cpu の両方を指定すると対戦カードが決まる", () => {
    const r = run("?player=javascript&cpu=haskell");
    const preset = Either.getOrUndefined(r)?.preset;
    expect(preset !== undefined && Option.isSome(preset) ? [preset.value.Player.id, preset.value.Cpu.id] : []).toEqual([
      "javascript",
      "haskell",
    ]);
  });

  it("片方だけ・未知の ID は型付きエラー", () => {
    const tag = (search: string) => Either.match(run(search), { onLeft: (e) => e._tag, onRight: () => "Right" });
    expect(tag("?player=python")).toBe("InvalidGameData");
    expect(tag("?player=python&cpu=rust")).toBe("UnknownCharacter");
  });
});
