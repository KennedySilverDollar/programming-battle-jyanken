import { Option, Schema } from "effect";
import * as Phaser from "phaser";
import { PROTOCOL_VERSION, RoomCode, type ServerMessage, type SyncState } from "@pbj/shared/protocol";
import { createAvatar, type FighterAvatar, preloadLogos } from "../game/avatar";
import { createBackdrop, fadeIn, fadeOutThen, popIn } from "../game/fx";
import type { GameSession } from "../game/session";
import { bindKeys, createButton, GAME_WIDTH, textStyle, wrapByChars } from "../game/widgets";
import type { ConnectionStatus, OnlineConnection } from "./connection";
import { normalizeRoomCode, ROOM_CODE_LENGTH } from "./roomCode";
import { errorText } from "./texts";

type Lobby = Extract<SyncState, { readonly _tag: "Lobby" }>;
type Mode = { readonly _tag: "Menu" } | { readonly _tag: "Code" } | { readonly _tag: "Room" };

const decodeRoomCode = Schema.decodeUnknownOption(RoomCode);

const STATUS_TEXT: Readonly<Record<ConnectionStatus, string>> = {
  connecting: "サーバーに接続しています…",
  open: "サーバーに接続しました",
  reconnecting: "サーバーに接続できません。再試行しています…（休止中のサーバーは起動に 1 分ほどかかります）",
};

/**
 * ルームコードの入力欄（本物の HTML の input）。キャンバスへのキー入力と違い、
 * IME・全角・貼り付け・スマートフォンのソフトキーボードでも入力できる。
 */
const createCodeInput = (): HTMLInputElement => {
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.autocapitalize = "characters";
  input.placeholder = "ABC234";
  input.setAttribute("aria-label", "ルームコード");
  // 全角で打たれても正規化するので、ここでは少し余裕を持たせる（正規化後に 6 文字へ切り詰める）
  input.maxLength = ROOM_CODE_LENGTH * 4;
  input.style.cssText = [
    "width: 300px",
    "height: 56px",
    "box-sizing: border-box",
    "padding: 0 12px",
    "font: bold 32px monospace",
    "letter-spacing: 8px",
    "text-align: center",
    "text-transform: uppercase",
    "color: #ffd866",
    "background: #11141c",
    "border: 3px solid #ffd866",
    "border-radius: 6px",
    "outline: none",
    // DOM コンテナは pointer-events: none なので、入力欄だけ受け付ける
    "pointer-events: auto",
  ].join(";");
  return input;
};

/**
 * オンライン対戦のロビー：キャラを選び、ルームを作る（コードが発行される）か、コードを入力して参加する。
 * 2 人そろったらルームの作成者が開始する。試合が始まったら（StateSync が試合中になったら）戦闘 Scene へ。
 */
export class LobbyScene extends Phaser.Scene {
  constructor(private readonly session: GameSession) {
    super("lobby");
  }

  preload(): void {
    preloadLogos(this, this.session.roster);
  }

  create(): void {
    fadeIn(this);
    const roster = this.session.roster;
    const conn: OnlineConnection = this.session.online();
    createBackdrop(this, [0x7fdbff, 0xffd866]);

    this.add
      .text(GAME_WIDTH / 2, 44, "🌐 オンライン対戦", { ...textStyle(36), fontStyle: "bold" })
      .setOrigin(0.5)
      .setStroke("#0b0d12", 6);
    const statusText = this.add.text(GAME_WIDTH / 2, 88, "", textStyle(18, "#9aa4b8")).setOrigin(0.5);
    const charName = this.add.text(GAME_WIDTH / 2, 380, "", { ...textStyle(28), fontStyle: "bold" }).setOrigin(0.5);
    const charSkill = this.add
      .text(GAME_WIDTH / 2, 420, "", { ...textStyle(18, "#c8d0e0"), align: "center" })
      .setOrigin(0.5);
    const main = this.add
      .text(GAME_WIDTH / 2, 480, "", { ...textStyle(30, "#ffd866"), fontStyle: "bold", align: "center" })
      .setOrigin(0.5);
    const sub = this.add.text(GAME_WIDTH / 2, 530, "", { ...textStyle(20), align: "center" }).setOrigin(0.5);
    const errorLine = this.add.text(GAME_WIDTH / 2, 690, "", textStyle(20, "#ff6b6b")).setOrigin(0.5);

    let mode: Mode = { _tag: "Menu" };
    let lobby: Option.Option<Lobby> = Option.none();
    let leaving = false;
    let avatar: FighterAvatar | null = null;

    const input = createCodeInput();
    // 「ルームを作る」の位置（コード入力中は非表示）に置き、右の「参加する」と横に並べる
    const inputObject = this.add.dom(GAME_WIDTH / 2 - 180, 610, input).setVisible(false);

    const character = () => roster[this.session.onlineCharacter] ?? roster[0];

    const go = (scene: "select" | "online-battle"): void => {
      if (leaving) return;
      leaving = true;
      fadeOutThen(this, () => this.scene.start(scene));
    };

    const buttons = {
      prev: createButton(
        this,
        GAME_WIDTH / 2 - 260,
        260,
        "◀ (A)",
        () => {
          cycle(-1);
        },
        120,
      ),
      next: createButton(
        this,
        GAME_WIDTH / 2 + 260,
        260,
        "▶ (D)",
        () => {
          cycle(1);
        },
        120,
      ),
      create: createButton(
        this,
        GAME_WIDTH / 2 - 180,
        610,
        "ルームを作る (N)",
        () => {
          createRoom();
        },
        300,
      ),
      join: createButton(
        this,
        GAME_WIDTH / 2 + 180,
        610,
        "コードで参加 (J)",
        () => {
          startCode();
        },
        300,
      ),
      submit: createButton(
        this,
        GAME_WIDTH / 2 + 180,
        610,
        "参加する (Enter)",
        () => {
          submitCode();
        },
        300,
      ),
      start: createButton(
        this,
        GAME_WIDTH / 2 - 180,
        610,
        "開始 (Enter)",
        () => {
          startMatch();
        },
        300,
      ),
      copy: createButton(
        this,
        GAME_WIDTH / 2 + 180,
        610,
        "招待リンクをコピー (L)",
        () => {
          copyLink();
        },
        300,
      ),
      back: createButton(
        this,
        120,
        670,
        "戻る (Esc)",
        () => {
          back();
        },
        180,
      ),
    };

    const render = (): void => {
      statusText.setText(`${STATUS_TEXT[conn.status]}（${conn.url}）`);
      const c = character();
      const inRoom = mode._tag === "Room";
      charName.setText(c.name);
      charSkill.setText(wrapByChars(`スキル：${c.skill.displayName} — ${c.skill.description}`, 56));
      buttons.prev.setVisible(!inRoom);
      buttons.next.setVisible(!inRoom);
      buttons.create.setVisible(mode._tag === "Menu");
      buttons.join.setVisible(mode._tag === "Menu");
      buttons.submit.setVisible(mode._tag === "Code");
      inputObject.setVisible(mode._tag === "Code");
      switch (mode._tag) {
        case "Menu":
          main.setText("キャラを選んで、ルームを作るか参加してください");
          sub.setText("A / D : キャラ    N : ルームを作る    J : コードで参加");
          buttons.start.setVisible(false);
          buttons.copy.setVisible(false);
          return;
        case "Code":
          main.setText("ルームコード（英数字 6 文字）を入力して「参加する」");
          sub.setText("");
          buttons.start.setVisible(false);
          buttons.copy.setVisible(false);
          return;
        case "Room":
          Option.match(lobby, {
            onNone: () => {
              main.setText("ルームに入っています…");
              sub.setText("");
              buttons.start.setVisible(false);
              buttons.copy.setVisible(false);
            },
            onSome: (l) => {
              main.setText(`ルームコード：${l.roomCode}`);
              const opponentId = l.you === "P1" ? l.characters.P2 : l.characters.P1;
              const opponent = roster.find((r) => r.id === opponentId)?.name;
              const waiting = l.you === "P1" ? "開始 (Enter) で試合を始めます" : "ルームの作成者の開始を待っています…";
              sub.setText(
                opponent === undefined
                  ? "相手の参加を待っています…（コードか招待リンクを相手に伝えてください）"
                  : `相手：${opponent}    ${waiting}`,
              );
              buttons.start.setVisible(l.you === "P1" && l.roomState === "READY");
              buttons.copy.setVisible(l.roomState === "WAITING");
            },
          });
          return;
      }
    };

    const renderAvatar = (): void => {
      avatar?.root.destroy();
      avatar = createAvatar(this, character(), GAME_WIDTH / 2, 230, 1);
      avatar.enter(0);
      avatar.startIdle();
    };

    const cycle = (delta: number): void => {
      if (mode._tag === "Room") return;
      this.session.onlineCharacter = (this.session.onlineCharacter + delta + roster.length) % roster.length;
      renderAvatar();
      render();
    };

    const createRoom = (): void => {
      if (mode._tag !== "Menu") return;
      errorLine.setText("");
      mode = { _tag: "Room" };
      conn.send({ _tag: "CreateRoom", characterId: character().id, protocolVersion: PROTOCOL_VERSION });
      render();
    };

    /** 入力欄の中身を正規化して書き戻す（IME の変換中は触らない）。 */
    const normalizeInput = (): string => {
      const { code, hadConfusable } = normalizeRoomCode(input.value);
      if (input.value !== code) input.value = code;
      if (hadConfusable) errorLine.setColor("#ffd866").setText("コードに 0・O・1・I は使われていません");
      return code;
    };

    const enterCode = (initial: string): void => {
      mode = { _tag: "Code" };
      input.value = initial;
      render();
      // Phaser は表示の切り替えを次の描画で反映するので、ここで直接表示してからフォーカスする
      // （非表示のままの要素にはフォーカスできない）。ボタン・キー操作の直後なので、スマートフォンでもキーボードが開く
      input.style.display = "block";
      input.focus();
    };

    const leaveCode = (): void => {
      input.blur();
    };

    const startCode = (): void => {
      if (mode._tag !== "Menu") return;
      errorLine.setText("");
      enterCode("");
    };

    const submitCode = (): void => {
      if (mode._tag !== "Code") return;
      const code = normalizeInput();
      Option.match(decodeRoomCode(code), {
        onNone: () => {
          errorLine
            .setColor("#ff6b6b")
            .setText(`コードは英数字 ${String(ROOM_CODE_LENGTH)} 文字です（いま ${String(code.length)} 文字）`);
          input.focus();
        },
        onSome: (roomCode) => {
          errorLine.setText("");
          leaveCode();
          mode = { _tag: "Room" };
          conn.send({ _tag: "JoinRoom", roomCode, characterId: character().id });
          render();
        },
      });
    };

    const startMatch = (): void => {
      Option.map(
        Option.filter(lobby, (l) => mode._tag === "Room" && l.you === "P1" && l.roomState === "READY"),
        (l) => {
          conn.send({ _tag: "StartMatch", roomCode: l.roomCode });
        },
      );
    };

    const copyLink = (): void => {
      Option.map(lobby, (l) => {
        const url = `${window.location.origin}${window.location.pathname}?room=${l.roomCode}`;
        navigator.clipboard.writeText(url).then(
          () => errorLine.setColor("#4cd964").setText("招待リンクをコピーしました"),
          () => errorLine.setColor("#ffd866").setText(url),
        );
      });
    };

    const back = (): void => {
      switch (mode._tag) {
        case "Menu":
          go("select");
          return;
        case "Code":
          leaveCode();
          errorLine.setText("");
          mode = { _tag: "Menu" };
          render();
          return;
        case "Room":
          Option.map(lobby, (l) => {
            conn.send({ _tag: "LeaveRoom", roomCode: l.roomCode });
          });
          lobby = Option.none();
          mode = { _tag: "Menu" };
          render();
          return;
      }
    };

    const onMessage = (m: ServerMessage): void => {
      switch (m._tag) {
        case "StateSync": {
          const s = m.state;
          if (s._tag === "Match") {
            if (s.roomState === "PLAYING") go("online-battle");
            return;
          }
          if (s.roomState === "CLOSED") {
            lobby = Option.none();
            if (mode._tag === "Room") {
              mode = { _tag: "Menu" };
              errorLine.setColor("#ffd866").setText("ルームが閉じられました");
            }
          } else {
            lobby = Option.some(s);
            mode = { _tag: "Room" };
          }
          render();
          return;
        }
        case "Error":
          errorLine.setColor("#ff6b6b").setText(errorText(m.code, m.message));
          // 参加・作成に失敗したらメニューに戻す
          if (mode._tag === "Room" && Option.isNone(lobby)) mode = { _tag: "Menu" };
          render();
          return;
        case "RoomJoined":
        case "MoveAccepted":
        case "TurnResolved":
        case "SkillActivated":
        case "HiddenTraitTriggered":
        case "MatchFinished":
          return;
      }
    };

    const unsubscribe = conn.subscribe(onMessage);
    const unsubscribeStatus = conn.onStatus(() => {
      render();
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      unsubscribe();
      unsubscribeStatus();
    });

    // 既にルームにいる（再戦の後・再接続した）なら、その状態から描く
    Option.map(conn.lastSync, (m) => {
      onMessage(m);
    });

    // 入力欄：Enter で参加、Esc で戻る。キーはゲームのショートカット（A / D / N / J / L）に渡さない
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        submitCode();
      } else if (e.key === "Escape") {
        e.preventDefault();
        back();
      }
    });
    input.addEventListener("keyup", (e) => {
      e.stopPropagation();
    });
    input.addEventListener("input", (e) => {
      if (e instanceof InputEvent && e.isComposing) return;
      normalizeInput();
    });
    input.addEventListener("compositionend", () => {
      normalizeInput();
    });

    const keyboard = this.input.keyboard;
    const onKey = (e: KeyboardEvent): void => {
      // コード入力中の文字は入力欄が受け取る
      if (mode._tag === "Code") return;
      const shortcuts: Readonly<Record<string, () => void>> = {
        A: () => {
          cycle(-1);
        },
        D: () => {
          cycle(1);
        },
        N: createRoom,
        J: startCode,
        ENTER: startMatch,
        L: copyLink,
      };
      const action = shortcuts[e.key.toUpperCase()];
      if (action === undefined) return;
      // J で入力欄を開いたとき、その J 自体が入力欄に入らないようにする
      e.preventDefault();
      action();
    };
    if (keyboard !== null) {
      keyboard.on("keydown", onKey);
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => keyboard.off("keydown", onKey));
    }
    bindKeys(this, [["keydown-ESC", back]]);

    // URL の ?room=XXXXXX で招待されたら、コード入力済みの状態から始める（既にルームにいれば何もしない）
    const invited = decodeRoomCode(new URLSearchParams(window.location.search).get("room"));
    const inMenu = (): boolean => mode._tag === "Menu";
    if (Option.isSome(invited) && inMenu()) enterCode(invited.value);

    renderAvatar();
    render();
    for (const b of [buttons.create, buttons.join]) popIn(this, b, 200, 0.7);
  }
}
