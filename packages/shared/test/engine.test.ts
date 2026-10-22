import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { beginResolution, type EngineEvent, finishResolution, proxyMoves, skillOrder, traitOrder } from "../src/engine";
import type { Move } from "../src/move";
import { seededRandomLayer } from "../src/random";
import type { Side } from "../src/side";
import { type GameState, initialGameState, playableMoves } from "../src/state";
import { character, gameData } from "./helpers";

/** state（スナップショット）を除いた JSON。 */
const body = (events: readonly EngineEvent[]): string =>
  JSON.stringify(events, (key: string, value: unknown) => (key === "state" ? undefined : value));

/** 両者の入力列（undefined は時間切れ＝代理選択）でターンを回し、出来事の列を返す。 */
const run = (
  seed: number,
  p1: string,
  p2: string,
  inputs: readonly (readonly [Move | undefined, Move | undefined])[],
) =>
  Effect.runSync(
    Effect.gen(function* () {
      let state = initialGameState({ P1: character(p1), P2: character(p2) });
      const log: EngineEvent[] = [];
      for (const [a, b] of inputs) {
        const chosen: Record<Side, Option.Option<Move>> = {
          P1: Option.filter(Option.fromNullable(a), (m) => isPlayable(state, "P1", m)),
          P2: Option.filter(Option.fromNullable(b), (m) => isPlayable(state, "P2", m)),
        };
        const moves = yield* proxyMoves(state, chosen);
        const phase = yield* Effect.orDie(beginResolution(state, moves));
        const extras = { P1: Option.none<Move>(), P2: Option.none<Move>() };
        const done = yield* Effect.orDie(finishResolution(gameData.balance, phase, extras));
        log.push(...phase.events, ...done.events);
        state = done.state;
        if (done.result._tag !== "Continue") break;
      }
      return log;
    }).pipe(Effect.provide(seededRandomLayer(seed))),
  );

const isPlayable = (state: GameState, side: Side, m: Move): boolean => playableMoves(state.fighters[side]).includes(m);

describe("ターン解決エンジン", () => {
  const a: readonly Move[] = ["Slash", "Thrust", "Bash"];
  const b: readonly Move[] = ["Bash", "Slash", "Thrust"];
  const inputs = Array.from({ length: 40 }, (_, i): readonly [Move | undefined, Move | undefined] => [
    i % 5 === 0 ? undefined : a[i % 3],
    i % 7 === 0 ? undefined : b[i % 3],
  ]);

  it("同じシード・同じ入力列からは同じ出来事の列になる（時間切れの代理選択も含む）", () => {
    const pairs: readonly (readonly [string, string])[] = [
      ["java", "haskell"],
      ["c", "php"],
      ["cpp", "javascript"],
    ];
    for (const [p1, p2] of pairs) {
      const a = run(12345, p1, p2, inputs);
      const b = run(12345, p1, p2, inputs);
      expect(a.length).toBeGreaterThan(0);
      expect(body(a)).toBe(body(b));
    }
  });

  it("シードが違えば（乱数を使う組み合わせなら）結果も変わる", () => {
    expect(body(run(1, "java", "php", inputs))).not.toBe(body(run(2, "java", "php", inputs)));
  });

  it("スキル判定は Haskell → Java → その他、隠れデメリットはキャラ ID の辞書順", () => {
    const s = (p1: string, p2: string) => initialGameState({ P1: character(p1), P2: character(p2) });
    expect(skillOrder(s("python", "haskell"))).toEqual(["P2", "P1"]);
    expect(skillOrder(s("java", "haskell"))).toEqual(["P2", "P1"]);
    expect(skillOrder(s("php", "java"))).toEqual(["P2", "P1"]);
    expect(skillOrder(s("php", "c"))).toEqual(["P1", "P2"]);
    expect(traitOrder(s("php", "c"))).toEqual(["P2", "P1"]);
    expect(traitOrder(s("javascript", "java"))).toEqual(["P2", "P1"]);
    expect(traitOrder(s("c", "cpp"))).toEqual(["P1", "P2"]);
  });
});
