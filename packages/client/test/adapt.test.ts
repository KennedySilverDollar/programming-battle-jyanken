import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { beginResolution, finishResolution } from "@pbj/shared/engine";
import { findCharacter, loadGameData } from "@pbj/shared/gameData";
import { matchSync, publicEvent } from "@pbj/shared/publicize";
import { seededRandomLayer } from "@pbj/shared/random";
import { initialGameState } from "@pbj/shared/state";
import {
  battleEventFrom,
  choiceFrom,
  type MatchSync,
  ownPrivate,
  type Perspective,
  relative,
} from "../src/online/adapt";
import type { RoomCode } from "@pbj/shared/protocol";
import { Schema } from "effect";
import { RoomCode as RoomCodeSchema } from "@pbj/shared/protocol";

const data = Effect.runSync(loadGameData());
const java = Effect.runSync(findCharacter(data.roster, "java"));
const python = Effect.runSync(findCharacter(data.roster, "python"));
const code: RoomCode = Schema.decodeUnknownSync(RoomCodeSchema)("ABCDEF");
const state = initialGameState({ P1: java, P2: python });

const syncFor = (you: "P1" | "P2"): MatchSync => {
  const s = matchSync({
    roomCode: code,
    roomState: "PLAYING",
    matchState: "SELECTING",
    state,
    you,
    scores: { P1: 1, P2: 0 },
    selected: { P1: false, P2: false },
    extraFor: [],
    remainingMs: 15000,
    connected: { P1: true, P2: true },
  });
  if (s._tag !== "Match") throw new Error("試合中の同期ではない");
  return s;
};

const perspective = (you: "P1" | "P2"): Perspective => ({ you, characters: { P1: java, P2: python } });

describe("オンライン表示の変換", () => {
  it("relative は自分を常に P1 にし、自分自身の逆写像になる", () => {
    expect(relative("P1")("P2")).toBe("P2");
    expect(relative("P2")("P2")).toBe("P1");
    expect(relative("P2")(relative("P2")("P1"))).toBe("P1");
  });

  it("P2 の視点では、自分（Python）が左・相手（Java）が右になる", () => {
    const view = choiceFrom(perspective("P2"), syncFor("P2"));
    expect(view.self.character.id).toBe("python");
    expect(view.self.side).toBe("P1");
    expect(view.opponent.character.id).toBe("java");
    expect(view.opponentHandTotal).toBe(java.cards.Slash + java.cards.Thrust + java.cards.Bash);
    expect(Option.isNone(view.opponent.revealedHand)).toBe(true);
  });

  it("勝敗は自分から見た結果に変換される", () => {
    const phase = Effect.runSync(
      beginResolution(state, { P1: "Bash", P2: "Slash" }).pipe(Effect.provide(seededRandomLayer(1))),
    );
    const done = Effect.runSync(
      finishResolution(data.balance, phase, { P1: Option.none(), P2: Option.none() }).pipe(
        Effect.provide(seededRandomLayer(1)),
      ),
    );
    const exchange = done.events.find((e) => e._tag === "ExchangeResolved");
    if (exchange === undefined) throw new Error("判定が無い");
    const pub = publicEvent(exchange);
    const outcomeFor = (you: "P1" | "P2") => {
      const own = ownPrivate(syncFor(you).self);
      const e = battleEventFrom(perspective(you), pub, own, null, 1, 1, () => false);
      return e._tag === "ExchangeResolved" ? [e.outcome, e.damage?.target] : [];
    };
    // 打撃（パー）> 斬撃（グー）なので P1 の勝ち
    expect(outcomeFor("P1")).toEqual(["Win", "P2"]);
    expect(outcomeFor("P2")).toEqual(["Lose", "P1"]);
  });
});
