import { Cause, Effect, Exit, Fiber, Option, Queue } from "effect";
import * as Phaser from "phaser";
import { AchievementStore } from "@pbj/shared/achievements";
import type { CharacterSpec } from "@pbj/shared/characters";
import { BattleEvent } from "@pbj/shared/events";
import type { Move } from "@pbj/shared/move";
import type { MatchId, ServerMessage } from "@pbj/shared/protocol";
import { opponentOf, type Side } from "@pbj/shared/side";
import { fadeIn, fadeOutThen } from "../game/fx";
import type { GameSession } from "../game/session";
import { BattleUi } from "../game/ui";
import { bindKeys } from "../game/widgets";
import {
  choiceFrom,
  type MatchSync,
  type OwnPrivate,
  ownPrivate,
  type Perspective,
  relative,
  relativeWins,
  syncView,
  turnEvents,
} from "./adapt";
import { errorText } from "./texts";

type StateSyncMsg = Extract<ServerMessage, { readonly _tag: "StateSync" }>;

const skillKey = (turn: number, side: Side, skillId: string): string => `${String(turn)}:${side}:${skillId}`;

/**
 * オンライン対戦の画面。ゲームの判定はすべてサーバーが行い、ここは届いたメッセージを順に演出するだけ。
 * - 受信メッセージはキューに積み、1 本の Fiber が演出の完了を待ちながら順に処理する（update() では何もしない）
 * - 手の選択は SelectMove / SelectExtraMove を送るだけ。締め切りの判定もサーバー（残り時間は表示のみ）
 */
export class OnlineBattleScene extends Phaser.Scene {
  constructor(private readonly session: GameSession) {
    super("online-battle");
  }

  create(): void {
    const conn = this.session.online();
    const initial = Option.getOrUndefined(conn.lastSync);
    const roster = this.session.roster;
    const toLobby = (): void => {
      fadeOutThen(this, () => this.scene.start("lobby"));
    };
    if (initial?.state._tag !== "Match" || initial.matchId === null) {
      this.scene.start("lobby");
      return;
    }
    const first: MatchSync = initial.state;
    const find = (id: string): CharacterSpec | undefined => roster.find((c) => c.id === id);
    const mine = find(first.self.characterId);
    const theirs = find(first.opponent.characterId);
    if (mine === undefined || theirs === undefined) {
      this.scene.start("lobby");
      return;
    }
    fadeIn(this);

    const you = first.you;
    const rel = relative(you);
    const p: Perspective = {
      you,
      characters: you === "P1" ? { P1: mine, P2: theirs } : { P1: theirs, P2: mine },
    };

    // 表示用の状態（判定には使わない）
    const matchId: MatchId = initial.matchId;
    let latest: MatchSync = first;
    let own: OwnPrivate = ownPrivate(first.self);
    let presentedRound = 0;
    let selectionKey: string | null = null;
    let cancelSelection: () => void = () => undefined;
    let finished: Option.Option<MatchId> = Option.none();
    let rematchAsked = false;
    /** 締め切り（Phaser の時刻）。残り秒数の表示にだけ使う。 */
    let deadlineAt: number | null = null;
    const pendingSkills: Extract<ServerMessage, { readonly _tag: "SkillActivated" }>[] = [];
    const shownSkills = new Set<string>();
    const firstUnlocks = new Map<string, boolean>();

    const rematch = (): void => {
      if (Option.isNone(finished) || rematchAsked) return;
      rematchAsked = true;
      conn.send({ _tag: "Rematch", matchId: finished.value });
      ui.notice("再戦を申し込みました（相手の同意待ち）");
    };
    const leave = (): void => {
      if (Option.isNone(finished)) return;
      conn.send({ _tag: "LeaveRoom", roomCode: latest.roomCode });
      toLobby();
    };

    const ui = new BattleUi(this, syncView(p, first), {
      onRestart: rematch,
      onBackToSelect: leave,
      labels: { opponentTag: "(相手)", restart: "再戦 (R)", back: "ロビーへ (C)" },
    });
    bindKeys(this, [
      [
        "keydown-A",
        () => {
          ui.moveCursor(-1);
        },
      ],
      [
        "keydown-D",
        () => {
          ui.moveCursor(1);
        },
      ],
      [
        "keydown-J",
        () => {
          ui.confirm();
        },
      ],
      ["keydown-R", rematch],
      ["keydown-C", leave],
    ]);

    const statusLine = (): string => {
      const parts: string[] = [];
      if (conn.status !== "open") parts.push("サーバーに再接続しています…");
      if (!latest.connected[opponentOf(you)]) parts.push("相手の接続が切れています（30 秒で戻らなければ不戦勝）");
      if (Option.isNone(finished) && deadlineAt !== null) {
        const sec = Math.max(0, Math.ceil((deadlineAt - this.time.now) / 1000));
        const waiting = latest.playable.length === 0 ? "相手の選択を待っています" : "手を選んでください";
        parts.push(`${waiting}  残り ${String(sec)} 秒`);
      }
      return parts.join("    ");
    };
    const tick = this.time.addEvent({
      delay: 250,
      loop: true,
      callback: () => {
        ui.setStatus(statusLine());
      },
    });

    const present = (event: BattleEvent): Effect.Effect<void> =>
      Effect.async((resume) => {
        const cancel = ui.present(event, () => {
          resume(Effect.void);
        });
        return Effect.sync(cancel);
      });

    const endSelection = (): void => {
      if (selectionKey === null) return;
      selectionKey = null;
      cancelSelection();
    };

    const decide =
      (turn: number, extra: boolean) =>
      (move: Move): void => {
        conn.send(
          extra ? { _tag: "SelectExtraMove", matchId, turn, move } : { _tag: "SelectMove", matchId, turn, move },
        );
      };

    const onSync = (m: StateSyncMsg): Effect.Effect<void> =>
      Effect.gen(this, function* () {
        const s = m.state;
        if (s._tag === "Lobby") {
          if (s.roomState === "CLOSED") {
            ui.notice("ルームが閉じられました");
            toLobby();
          }
          return;
        }
        // 再戦で新しいマッチが始まったら、画面を作り直す
        if (m.matchId !== null && m.matchId !== matchId) {
          this.scene.restart();
          return;
        }
        latest = s;
        own = ownPrivate(s.self);
        deadlineAt = s.remainingMs === null ? null : this.time.now + s.remainingMs;
        if (s.round !== presentedRound) {
          presentedRound = s.round;
          yield* present(
            BattleEvent.RoundStarted({ round: s.round, wins: relativeWins(you, s.scores), view: syncView(p, s) }),
          );
        }
        // イベントループ待ちに入ったら、先に届いていたスキル発動を見せる
        if (s.matchState === "EXTRA_SELECTING") {
          for (const a of pendingSkills.splice(0)) {
            shownSkills.add(skillKey(a.turn, rel(a.player), a.skillId));
            yield* present(
              BattleEvent.SkillActivated({
                side: rel(a.player),
                skillId: a.skillId,
                name: a.skillName,
                description: p.characters[a.player].skill.description,
                detail: a.effect,
                view: syncView(p, s),
              }),
            );
          }
        }
        const canChoose = s.playable.length > 0;
        const key = canChoose ? `${String(s.turn)}:${String(s.extraForYou)}` : null;
        if (key !== null && key !== selectionKey) {
          endSelection();
          selectionKey = key;
          const view = choiceFrom(p, s);
          const onDecide = decide(s.turn, s.extraForYou);
          cancelSelection = s.extraForYou ? ui.beginExtraSelection(view, onDecide) : ui.beginSelection(view, onDecide);
        } else if (key === null) {
          endSelection();
          ui.render(syncView(p, s), Option.fromNullable(s.opponentHandTotal));
        }
        ui.setStatus(statusLine());
      });

    const unlock = (achievementId: string): Effect.Effect<void> =>
      Effect.flatMap(AchievementStore, (store) => store.unlock(achievementId)).pipe(
        Effect.catchTag("AchievementStorageError", () => Effect.succeed(false)),
        Effect.map((first) => {
          firstUnlocks.set(achievementId, first || (firstUnlocks.get(achievementId) ?? false));
        }),
        Effect.provide(this.session.achievementStore),
      );

    const handle = (m: ServerMessage): Effect.Effect<void> =>
      Effect.gen(function* () {
        switch (m._tag) {
          case "StateSync":
            return yield* onSync(m);
          case "SkillActivated":
            pendingSkills.push(m);
            return;
          case "HiddenTraitTriggered":
            return yield* unlock(m.achievementId);
          case "TurnResolved": {
            if (m.matchId !== matchId) return;
            endSelection();
            deadlineAt = null;
            pendingSkills.length = 0;
            const events = turnEvents(p, m, own, latest.opponentRevealedHand, (id) => firstUnlocks.get(id) ?? false);
            for (const e of events) {
              if (e._tag === "SkillActivated" && shownSkills.has(skillKey(m.turn, e.side, e.skillId))) continue;
              yield* present(e);
            }
            shownSkills.clear();
            firstUnlocks.clear();
            return;
          }
          case "MatchFinished": {
            if (m.matchId !== matchId) return;
            endSelection();
            deadlineAt = null;
            finished = Option.some(m.matchId);
            const winner = rel(m.winner);
            switch (m.reason) {
              case "Decided":
                break;
              case "Forfeit":
                ui.notice(winner === "P1" ? "相手が退出しました" : "退出したため負けになりました");
                break;
              case "Disconnected":
                ui.notice(winner === "P1" ? "相手の接続が切れたため不戦勝" : "接続が切れたため負けになりました");
                break;
            }
            return yield* present(
              BattleEvent.MatchEnded({ winner, wins: relativeWins(you, m.scores), view: syncView(p, latest) }),
            );
          }
          case "Error":
            ui.notice(errorText(m.code, m.message));
            return;
          case "RoomJoined":
          case "MoveAccepted":
            return;
        }
      });

    const program = Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<ServerMessage>();
        yield* Effect.acquireRelease(
          Effect.sync(() => conn.subscribe((m) => Queue.unsafeOffer(queue, m))),
          (unsubscribe) => Effect.sync(unsubscribe),
        );
        yield* handle(initial);
        return yield* Effect.forever(Effect.flatMap(Queue.take(queue), handle));
      }),
    );

    const unsubscribeStatus = conn.onStatus((status) => {
      if (status === "reconnecting") ui.notice("サーバーとの接続が切れました。再接続しています…");
      ui.setStatus(statusLine());
    });
    const fiber = Effect.runFork(program);
    fiber.addObserver((exit) => {
      if (Exit.isFailure(exit) && !Exit.isInterrupted(exit)) {
        console.error(Cause.pretty(exit.cause));
        ui.showFatal(Cause.pretty(exit.cause));
      }
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      tick.remove(false);
      unsubscribeStatus();
      Effect.runFork(Fiber.interrupt(fiber));
    });
  }
}
