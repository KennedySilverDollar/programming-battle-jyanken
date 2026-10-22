import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { handTotal } from "../src/hand";
import { constantRandomLayer, seededRandomLayer } from "../src/random";
import { firstRound, gameData, ofTag, repeat, runMatch } from "./helpers";

/** 確率判定がすべて不成立（スキルの確率発動・隠れデメリットが起きない）。 */
const never = constantRandomLayer(0.999);
/** 確率判定がすべて成立。 */
const always = constantRandomLayer(0);

describe("ベストオブ 3", () => {
  it("2 本先取でマッチ勝利。試合ごとに HP・手札をリセット", () => {
    // Python 同士。自分は斬撃、相手は刺突を出し続ける → 20 × 4 で毎試合勝つ
    const rec = runMatch({
      player: "python",
      cpu: "python",
      random: never,
      playerMoves: repeat("Slash", 8),
      cpuMoves: repeat("Thrust", 8),
    });
    expect(rec.result).toEqual({ winner: "P1", wins: { P1: 2, P2: 0 } });
    const ends = ofTag(rec.events, "RoundEnded");
    expect(ends).toHaveLength(2);
    expect(ends[0]?.view.opponent.hp).toBe(0);
    const starts = ofTag(rec.events, "RoundStarted");
    expect(starts.map((s) => s.round)).toEqual([1, 2]);
    // 2 試合目の開始時は満タン・手札 12 枚
    expect(starts[1]?.view.self.hp).toBe(80);
    expect(handTotal(starts[1]?.view.self.hand ?? { Slash: 0, Thrust: 0, Bash: 0 })).toBe(12);
    expect(ofTag(rec.events, "MatchEnded")[0]?.winner).toBe("P1");
  });
});

describe("基本ルール", () => {
  it("打撃で勝つと 10 ダメージ＋相手の手札を 1 枚捨て札へ", () => {
    const rec = runMatch({
      player: "python",
      cpu: "python",
      random: never,
      playerMoves: ["Bash"],
      cpuMoves: ["Slash"],
    });
    const ex = ofTag(rec.events, "ExchangeResolved")[0];
    expect(ex?.damage).toEqual({ target: "P2", amount: 10, deferred: false });
    expect(ex?.bashDiscard?.side).toBe("P2");
    expect(ex?.view.opponent.discard).toHaveLength(2); // 出した 1 枚＋捨てさせた 1 枚
  });

  it("あいこは両者ノーダメージで 1 枚ずつ消費", () => {
    const rec = runMatch({
      player: "python",
      cpu: "python",
      random: never,
      playerMoves: ["Thrust"],
      cpuMoves: ["Thrust"],
    });
    const ex = ofTag(rec.events, "ExchangeResolved")[0];
    expect(ex?.outcome).toBe("Draw");
    expect(ex?.damage).toBeNull();
    expect(ex?.view.self.discard).toEqual(["Thrust"]);
    expect(ex?.view.opponent.discard).toEqual(["Thrust"]);
  });

  it("手札 0 でも負けない。素手は好きな手を出せて、与ダメージ半減", () => {
    // 12 ターンあいこで両者素手 → 13 ターン目に斬撃 vs 刺突
    const draws = [...repeat("Slash", 4), ...repeat("Thrust", 4), ...repeat("Bash", 4)];
    const rec = runMatch({
      player: "python",
      cpu: "python",
      random: never,
      playerMoves: [...draws, "Slash"],
      cpuMoves: [...draws, "Thrust"],
    });
    const round1 = firstRound(rec.events);
    const bareChoice = rec.choices[12];
    expect(bareChoice?.self.bare).toBe(true);
    expect(bareChoice?.playable).toEqual(["Slash", "Thrust", "Bash"]);
    expect(bareChoice?.opponentHandTotal).toBe(0);
    const ex = ofTag(round1, "ExchangeResolved")[12];
    expect(ex?.damage).toEqual({ target: "P2", amount: 10, deferred: false });
  });
});

describe("Haskell「遅延評価」", () => {
  it("被ダメージはサンクに積まれ HP は減らない。勝つと最も古いサンクを破棄。サンクは相手にも見える", () => {
    const rec = runMatch({
      player: "python",
      cpu: "haskell",
      random: never,
      playerMoves: ["Slash", "Thrust", "Slash"],
      cpuMoves: ["Thrust", "Bash", "Bash"],
    });
    const ex = ofTag(rec.events, "ExchangeResolved");
    expect(ex[0]?.damage).toEqual({ target: "P2", amount: 20, deferred: true });
    expect(ex[0]?.view.opponent.hp).toBe(110);
    expect(Option.getOrNull(ex[1]?.view.opponent.thunks ?? Option.none())).toEqual({
      count: 2,
      total: 35,
      forced: false,
    });
    // 3 ターン目は Haskell の打撃が斬撃に勝つ → 最も古い 20 を破棄
    expect(ex[2]?.thunkDropped).toEqual({ side: "P2", amount: 20 });
    expect(Option.getOrNull(ex[2]?.view.opponent.thunks ?? Option.none())).toEqual({
      count: 1,
      total: 15,
      forced: false,
    });
    // 手選択画面でもサンクは見える
    expect(Option.isSome(rec.choices[0]?.opponent.thunks ?? Option.none())).toBe(true);
  });

  it("手札が 0 になった瞬間にサンクを強制評価（1 試合 1 回）、以後は直接ダメージ", () => {
    // Haskell 12 枚を、Player の刺突 vs Haskell の打撃以外で…ここでは毎ターン Player が勝つ組み合わせ
    const playerMoves = repeat("Slash", 12);
    const cpuMoves = repeat("Thrust", 12);
    const rec = runMatch({ player: "c", cpu: "haskell", random: never, playerMoves, cpuMoves });
    const round1 = firstRound(rec.events);
    const forced = ofTag(round1, "ThunksForced");
    expect(forced).toHaveLength(1);
    // 6 枚しかない斬撃が切れたあとは C の手札の先頭（刺突）になるので、合計は試合次第。HP は合計だけ減る
    const f = forced[0];
    expect(f?.side).toBe("P2");
    expect(f?.view.opponent.hp).toBe(Math.max(0, 110 - (f?.total ?? 0)));
    expect(Option.getOrNull(f?.view.opponent.thunks ?? Option.none())?.forced).toBe(true);
  });
});

describe("Java「ガベージコレクション」と dispose 忘れ", () => {
  it("毎ターン判定で何回でも発動し、STW で「次ターン」の与ダメージ -10。GC 3 回後に dispose 忘れで HP -5", () => {
    const rec = runMatch({
      player: "java",
      cpu: "python",
      random: always,
      playerMoves: repeat("Slash", 30),
      cpuMoves: repeat("Bash", 30),
    });
    const round1 = firstRound(rec.events);
    const gc = ofTag(round1, "SkillActivated").filter((e) => e.side === "P1");
    expect(gc.length).toBeGreaterThanOrEqual(3);
    // 1 ターン目は捨て札が無いので発動しない
    expect(gc[0]?.view.turn).toBe(2);
    expect(ofTag(round1, "StopTheWorld").length).toBe(gc.length);
    const trait = ofTag(round1, "TraitTriggered").filter((e) => e.traitId === "java.swt_leak");
    expect(trait.length).toBeGreaterThan(0);
    expect(trait[0]?.firstUnlock).toBe(true);
    expect(trait[1]?.firstUnlock).toBe(false);
    expect(rec.unlocked.has("forgot_dispose")).toBe(true);
  });
});

describe("C「動的メモリ確保」とセグメンテーション違反", () => {
  it("手札 5 枚以下で一時カードを追加。次のターンに使わなければ、そのターン終了時に捨て札へ", () => {
    // C 同士であいこを続ける。確率は不成立（never は配列の末尾＝打撃を選ぶので、一時カードは打撃）
    const draws = [...repeat("Slash", 6), ...repeat("Thrust", 3), ...repeat("Bash", 3)];
    const rec = runMatch({ player: "c", cpu: "c", random: never, playerMoves: draws, cpuMoves: draws });
    const round1 = firstRound(rec.events);
    const malloc = ofTag(round1, "SkillActivated").filter((e) => e.side === "P1");
    expect(malloc).toHaveLength(1);
    expect(malloc[0]?.view.turn).toBe(8); // 7 ターン後に手札 5 枚
    // スキルは手を出した後に判定されるので、8 ターン目のカードを出した後の 4 枚＋一時確保 1 枚
    expect(handTotal(malloc[0]?.view.self.hand ?? { Slash: 0, Thrust: 0, Bash: 0 })).toBe(5);
    // 確保したカードは次の 9 ターン目に使える。9 ターン目も刺突を出したので、打撃は 9 ターン目の終わりに捨て札へ
    expect(ofTag(round1, "TurnEnded").find((e) => e.view.turn === 8)).toBeUndefined();
    const released = ofTag(round1, "TurnEnded").find((e) => e.view.turn === 9);
    expect(released?.notes).toContainEqual({ _tag: "TempReleased", side: "P1", moves: ["Bash"] });
  });

  it("素手のターン 10% で手が不発になる（最後の 1 枚を出すターンは素手ではない）", () => {
    // あいこを続けて C を素手にする（Python には隠れデメリットが無い）。確率はすべて成立させる
    const common = [...repeat("Slash", 4), ...repeat("Thrust", 3), ...repeat("Bash", 3)];
    const rec = runMatch({
      player: "c",
      cpu: "python",
      random: always,
      playerMoves: [...common, "Slash", "Slash"],
      cpuMoves: common,
    });
    const round1 = firstRound(rec.events);
    const seg = ofTag(round1, "TraitTriggered").find((e) => e.traitId === "c.null_pointer");
    expect(seg?.firstUnlock).toBe(true);
    const revealed = ofTag(round1, "MovesRevealed").find((e) => e.plays.P1.effective._tag === "Fizzle");
    expect(revealed?.plays.P1.bare).toBe(true);
    expect(revealed?.view.turn).toBe(seg?.view.turn);
    // 不発の C に対して Python の手が一方的に通る
    const ex = ofTag(round1, "ExchangeResolved").find((e) => e.view.turn === revealed?.view.turn);
    expect(ex?.outcome).toBe("Lose");
    expect(rec.unlocked.has("segfault")).toBe(true);
  });
});

describe("C++「RAII」と解放漏れ", () => {
  it("HP 50% 以下で発動し、使ったカードを回収。次のターンはその 1 枚を使えない", () => {
    // 刺突 vs 斬撃で 20 × 3：85 → 25 で 4 ターン目に発動。4 ターン目に使った打撃を回収
    const rec = runMatch({
      player: "cpp",
      cpu: "python",
      random: never,
      playerMoves: ["Thrust", "Thrust", "Thrust", "Bash"],
      cpuMoves: ["Slash", "Slash", "Slash", "Thrust"],
    });
    const round1 = firstRound(rec.events);
    const raii = ofTag(round1, "SkillActivated").find((e) => e.side === "P1");
    expect(raii?.skillId).toBe("cpp.raii");
    const returned = ofTag(round1, "TurnEnded")
      .flatMap((e) => e.notes)
      .find((n) => n._tag === "RaiiReturned");
    expect(raii?.view.turn).toBe(4);
    expect(returned).toEqual({ _tag: "RaiiReturned", side: "P1", move: "Bash" });
    // 回収した次のターンは打撃 1 枚がロック（打撃は 2 枚あるので、もう 1 枚は使える）
    const nextChoice = rec.choices.find((c) => Option.isSome(c.self.locked));
    expect(nextChoice?.turn).toBe(5);
    expect(Option.getOrNull(nextChoice?.self.locked ?? Option.none())).toBe("Bash");
    expect(nextChoice?.self.hand.Bash).toBe(2);
    expect(nextChoice?.playable).toContain("Bash");
  });

  it("5 ターン目以降、手札の上限が減って超えた分が捨て札へ（UI には上限を出さない）", () => {
    const rec = runMatch({
      player: "cpp",
      cpu: "python",
      random: always,
      playerMoves: repeat("Bash", 20),
      cpuMoves: repeat("Slash", 20),
    });
    const round1 = firstRound(rec.events);
    const leak = ofTag(round1, "TraitTriggered").filter((e) => e.traitId === "cpp.memory_leak");
    expect(leak[0]?.view.turn).toBe(5);
    expect(rec.unlocked.has("memory_leak")).toBe(true);
  });
});

describe("JavaScript「イベントループ」と undefined", () => {
  it("3 ターン目以降・手札 4 枚以上で発動。相手の手を見てから追加の 1 手、どちらかが勝てば勝ち", () => {
    const rec = runMatch({
      player: "javascript",
      cpu: "python",
      random: never,
      playerMoves: ["Slash", "Slash", "Slash"],
      playerExtras: ["Thrust"],
      cpuMoves: ["Slash", "Slash", "Bash"],
    });
    const round1 = firstRound(rec.events);
    const loop = ofTag(round1, "SkillActivated").find((e) => e.side === "P1");
    expect(loop?.view.turn).toBe(3);
    const extra = ofTag(round1, "ExtraMovePlayed")[0];
    expect(extra?.move).toBe("Thrust");
    const ex = ofTag(round1, "ExchangeResolved")[2];
    expect(ex?.outcome).toBe("Win"); // 斬撃は打撃に負けるが、刺突が打撃に勝つ
    expect(ex?.winningMove).toBe("Thrust");
    expect(ex?.view.self.discard).toHaveLength(4); // 手札 2 枚消費
  });

  it("手札 3 枚以下のターン 10% で選んだ手が undefined になり、あいこ扱い", () => {
    const draws = [...repeat("Slash", 6), ...repeat("Bash", 4), ...repeat("Thrust", 2)];
    const rec = runMatch({
      player: "javascript",
      cpu: "javascript",
      random: always,
      playerMoves: draws,
      cpuMoves: draws,
    });
    const round1 = firstRound(rec.events);
    const reveals = ofTag(round1, "MovesRevealed");
    const i = reveals.findIndex((e) => e.plays.P1.effective._tag === "Undefined");
    expect(i).toBeGreaterThan(0);
    // 判定は手札を出す前（手札 3 枚以下）。出した後の手札は 2 枚以下
    expect(handTotal(reveals[i]?.view.self.hand ?? { Slash: 9, Thrust: 9, Bash: 9 })).toBeLessThanOrEqual(2);
    expect(ofTag(round1, "ExchangeResolved")[i]?.outcome).toBe("Draw");
    expect(rec.unlocked.has("undefined_is_not_a_function")).toBe(true);
  });
});

describe("Python「動的型付け」", () => {
  it("相手の手札 6 枚以下で発動し、以後は相手の手札内訳が公開される。発動前はどの画面でも非公開", () => {
    const rec = runMatch({
      player: "python",
      cpu: "python",
      random: never,
      playerMoves: repeat("Bash", 12),
      cpuMoves: repeat("Bash", 12),
    });
    const round1 = firstRound(rec.events);
    const act = ofTag(round1, "SkillActivated").find((e) => e.side === "P1");
    expect(act?.view.turn).toBe(7);
    const before = round1.slice(
      0,
      round1.findIndex((e) => e === act),
    );
    for (const e of before) expect(Option.isNone(e.view.opponent.revealedHand)).toBe(true);
    expect(Option.isSome(act?.view.opponent.revealedHand ?? Option.none())).toBe(true);
  });
});

describe("PHP「リクエストライフサイクル」と緩やかな比較の罠", () => {
  it("相手の手札 6 枚以下で相手の手札を 2 枚破壊", () => {
    const rec = runMatch({
      player: "php",
      cpu: "python",
      random: never,
      playerMoves: repeat("Bash", 12),
      cpuMoves: repeat("Bash", 12),
    });
    const act = ofTag(firstRound(rec.events), "SkillActivated").find((e) => e.side === "P1");
    expect(act?.detail).toMatchObject({ _tag: "Destroyed" });
    expect(act?.detail._tag === "Destroyed" ? act.detail.moves.length : 0).toBe(2);
    expect(act?.view.opponent.discard).toHaveLength(9); // 7 枚使用（このターンの分を含む）＋2 枚破壊
  });

  it("相手の手札 3 枚以下のターン 10% で手が別の手に変わる", () => {
    const rec = runMatch({
      player: "php",
      cpu: "python",
      random: always,
      playerMoves: repeat("Bash", 20),
      cpuMoves: repeat("Bash", 20),
    });
    const juggled = ofTag(firstRound(rec.events), "MovesRevealed").find(
      (e) => e.plays.P1.effective._tag === "Move" && e.plays.P1.effective.move !== e.plays.P1.chosen,
    );
    expect(juggled).toBeDefined();
    expect(rec.unlocked.has("loose_comparison")).toBe(true);
  });
});

describe("全組み合わせ × 多数シードの性質", () => {
  const ids = gameData.roster.map((c) => c.id);

  it("必ずマッチが決着し、不変条件違反も 1 回きりのスキルの再発動も起こらない", { timeout: 120_000 }, () => {
    for (const player of ids) {
      for (const cpu of ids) {
        for (let seed = 1; seed <= 6; seed++) {
          const rec = runMatch({ player, cpu, random: seededRandomLayer(seed) });
          expect(Math.max(rec.result.wins.P1, rec.result.wins.P2)).toBe(2);

          for (const round of splitRounds(rec.events)) {
            for (const side of ["P1", "P2"] as const) {
              const acts = ofTag(round, "SkillActivated").filter((e) => e.side === side);
              if (acts[0]?.skillId !== "java.gc") expect(acts.length).toBeLessThanOrEqual(1);
            }
            // 相手の手札内訳は、自分が Python のスキルを発動するまで見えない
            const reveal = ofTag(round, "SkillActivated").find(
              (e) => e.side === "P1" && e.skillId === "python.dynamic_typing",
            );
            const until = reveal === undefined ? round.length : round.indexOf(reveal);
            for (const e of round.slice(0, until)) expect(Option.isNone(e.view.opponent.revealedHand)).toBe(true);
            // Haskell のサンクは常に相手にも見える
            if (cpu === "haskell") for (const e of round) expect(Option.isSome(e.view.opponent.thunks)).toBe(true);
          }
        }
      }
    }
  });

  it("同じシードなら同じ結果（再現性）", () => {
    const a = runMatch({ player: "java", cpu: "php", random: seededRandomLayer(42) });
    const b = runMatch({ player: "java", cpu: "php", random: seededRandomLayer(42) });
    expect(a.result).toEqual(b.result);
    expect(a.events.map((e) => e._tag)).toEqual(b.events.map((e) => e._tag));
  });
});

const splitRounds = (events: readonly import("../src/events").BattleEvent[]) => {
  const rounds: (typeof events)[number][][] = [];
  for (const e of events) {
    if (e._tag === "RoundStarted") rounds.push([]);
    rounds[rounds.length - 1]?.push(e);
  }
  return rounds;
};
