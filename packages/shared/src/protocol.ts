import { Schema } from "effect";
import { Hand } from "./hand";
import { Move } from "./move";
import { Side } from "./side";
import { SkillId } from "./skills";
import { TraitId } from "./traits";

/**
 * オンライン対戦のプロトコル（WebSocket・JSON / UTF-8）。
 * すべてのメッセージは判別共用体（_tag）で、クライアント発は clientSeq、サーバー発は serverSeq を持つ。
 * 相手の手札の中身や、確定前の相手の手は、どのメッセージの型にも入る場所が無い（INV-6 を型で担保）。
 */

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// 基本の型
// ---------------------------------------------------------------------------

/** ルームコード：紛らわしい文字（0 O 1 I）を除いた英大文字・数字 6 桁。 */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const RoomCode = Schema.String.pipe(Schema.pattern(/^[A-HJ-NP-Z2-9]{6}$/), Schema.brand("RoomCode"));
export type RoomCode = typeof RoomCode.Type;

const Uuid = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
/** 再接続用のトークン（UUIDv4）。サーバーが発行・保持し、クライアントはローカルストレージにだけ保存する。 */
export const SessionToken = Uuid.pipe(Schema.brand("SessionToken"));
export type SessionToken = typeof SessionToken.Type;
/** マッチ（ベストオブ 3）の ID（UUIDv4）。乱数のシードはここから決まる。 */
export const MatchId = Uuid.pipe(Schema.brand("MatchId"));
export type MatchId = typeof MatchId.Type;

const Seq = Schema.Int.pipe(Schema.nonNegative());
const Count = Schema.Int.pipe(Schema.nonNegative());
const CharacterIdString = Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9-]*$/));

export const RoomState = Schema.Literal("WAITING", "READY", "PLAYING", "FINISHED", "CLOSED");
export type RoomState = typeof RoomState.Type;

/**
 * マッチの状態。仕様の 4 状態に、イベントループの追加の 1 手を待つ EXTRA_SELECTING を加えている
 * （両者の手の確定後・オープン前）。
 */
export const MatchState = Schema.Literal("IDLE", "SELECTING", "EXTRA_SELECTING", "RESOLVING", "MATCH_OVER");
export type MatchState = typeof MatchState.Type;

export const Outcome = Schema.Literal("P1Win", "P2Win", "Draw");
export type Outcome = typeof Outcome.Type;

// ---------------------------------------------------------------------------
// クライアント → サーバー
// ---------------------------------------------------------------------------

export const ClientMessage = Schema.Union(
  Schema.TaggedStruct("CreateRoom", { characterId: CharacterIdString, protocolVersion: Schema.Int, clientSeq: Seq }),
  Schema.TaggedStruct("JoinRoom", { roomCode: RoomCode, characterId: CharacterIdString, clientSeq: Seq }),
  /** READY → PLAYING。ルームの作成者（P1）だけが送れる。（仕様の遷移に対応するメッセージとして追加） */
  Schema.TaggedStruct("StartMatch", { roomCode: RoomCode, clientSeq: Seq }),
  Schema.TaggedStruct("SelectMove", {
    matchId: MatchId,
    turn: Schema.Int.pipe(Schema.positive()),
    move: Move,
    clientSeq: Seq,
  }),
  /** イベントループの追加の 1 手（EXTRA_SELECTING のときだけ）。（追加） */
  Schema.TaggedStruct("SelectExtraMove", {
    matchId: MatchId,
    turn: Schema.Int.pipe(Schema.positive()),
    move: Move,
    clientSeq: Seq,
  }),
  Schema.TaggedStruct("Rematch", { matchId: MatchId, clientSeq: Seq }),
  Schema.TaggedStruct("LeaveRoom", { roomCode: RoomCode, clientSeq: Seq }),
  Schema.TaggedStruct("Reconnect", { sessionToken: SessionToken, clientSeq: Seq }),
  /** 生存確認。10 秒届かなければ切断とみなす。（追加） */
  Schema.TaggedStruct("Heartbeat", { clientSeq: Seq }),
);
export type ClientMessage = typeof ClientMessage.Type;

// ---------------------------------------------------------------------------
// 公開情報（両者に同じ内容で送る）
// ---------------------------------------------------------------------------

export const ThunkInfo = Schema.Struct({ count: Count, total: Count, forced: Schema.Boolean });

/** 公開されている選手の状態。手札の中身は含まない。 */
export const PublicFighter = Schema.Struct({
  characterId: CharacterIdString,
  hp: Count,
  maxHp: Count,
  discard: Schema.Array(Move),
  skillUsed: Schema.Boolean,
  skillActivations: Count,
  thunks: Schema.NullOr(ThunkInfo),
  stwPenalty: Count,
});
export type PublicFighter = typeof PublicFighter.Type;

export const PublicFighters = Schema.Struct({ P1: PublicFighter, P2: PublicFighter });
export type PublicFighters = typeof PublicFighters.Type;

/** 自分だけに送る状態（StateSync）。 */
export const PrivateFighter = Schema.Struct({
  ...PublicFighter.fields,
  hand: Hand,
  locked: Schema.NullOr(Move),
  bare: Schema.Boolean,
});
export type PrivateFighter = typeof PrivateFighter.Type;

const EffectiveMove = Schema.Union(
  Schema.TaggedStruct("Move", { move: Move }),
  Schema.TaggedStruct("Undefined", {}),
  Schema.TaggedStruct("Fizzle", {}),
);
const RevealedPlay = Schema.Struct({ chosen: Move, bare: Schema.Boolean, effective: EffectiveMove });

/** スキルの効果（公開してよいものだけ。C の一時確保で何を引いたかは送らない）。 */
export const PublicActivation = Schema.Union(
  Schema.TaggedStruct("Recycled", { moves: Schema.Array(Move) }),
  Schema.TaggedStruct("Allocated", {}),
  Schema.TaggedStruct("RaiiArmed", {}),
  Schema.TaggedStruct("EventLoopArmed", {}),
  Schema.TaggedStruct("Revealed", {}),
  Schema.TaggedStruct("Destroyed", { moves: Schema.Array(Move) }),
);
export type PublicActivation = typeof PublicActivation.Type;

const Damage = Schema.Struct({ target: Side, amount: Count, deferred: Schema.Boolean });
const TurnNote = Schema.Union(
  Schema.TaggedStruct("TempReleased", { side: Side, moves: Schema.Array(Move) }),
  Schema.TaggedStruct("RaiiReturned", { side: Side, move: Move }),
);

/** ターン中の出来事（公開分）。fighters はその直後の公開状態。 */
export const PublicEvent = Schema.Union(
  Schema.TaggedStruct("SkillActivated", {
    side: Side,
    skillId: SkillId,
    name: Schema.String,
    description: Schema.String,
    detail: PublicActivation,
    fighters: PublicFighters,
  }),
  Schema.TaggedStruct("StopTheWorld", { side: Side, penalty: Count, fighters: PublicFighters }),
  Schema.TaggedStruct("TraitTriggered", {
    side: Side,
    traitId: TraitId,
    displayName: Schema.String,
    achievementId: Schema.String,
    fighters: PublicFighters,
  }),
  Schema.TaggedStruct("ThunksForced", { side: Side, total: Count, fighters: PublicFighters }),
  Schema.TaggedStruct("MovesRevealed", {
    plays: Schema.Struct({ P1: RevealedPlay, P2: RevealedPlay }),
    fighters: PublicFighters,
  }),
  Schema.TaggedStruct("ExtraMovePlayed", { side: Side, move: Move, fighters: PublicFighters }),
  Schema.TaggedStruct("ExchangeResolved", {
    winner: Schema.NullOr(Side),
    winningMove: Schema.NullOr(Move),
    damage: Schema.NullOr(Damage),
    bashDiscard: Schema.NullOr(Schema.Struct({ side: Side, moves: Schema.Array(Move) })),
    thunkDropped: Schema.NullOr(Schema.Struct({ side: Side, amount: Count })),
    fighters: PublicFighters,
  }),
  Schema.TaggedStruct("TurnEnded", { notes: Schema.Array(TurnNote), fighters: PublicFighters }),
);
export type PublicEvent = typeof PublicEvent.Type;

export const RoundResult = Schema.Union(
  Schema.TaggedStruct("Victory", { winner: Side, reason: Schema.Literal("HpDepleted", "TurnLimit") }),
  Schema.TaggedStruct("Draw", { reason: Schema.Literal("DoubleKnockout", "TurnLimit") }),
);

export const Scores = Schema.Struct({ P1: Count, P2: Count });

/** ロビー（WAITING / READY / FINISHED）の同期情報。 */
export const LobbySync = Schema.TaggedStruct("Lobby", {
  roomCode: RoomCode,
  roomState: RoomState,
  you: Side,
  characters: Schema.Struct({ P1: CharacterIdString, P2: Schema.NullOr(CharacterIdString) }),
  connected: Schema.Struct({ P1: Schema.Boolean, P2: Schema.Boolean }),
  scores: Scores,
});

/** 試合中の同期情報。自分の手札は含むが、相手の手札の中身・確定前の相手の手は含まない。 */
export const MatchSync = Schema.TaggedStruct("Match", {
  roomCode: RoomCode,
  roomState: RoomState,
  matchState: MatchState,
  you: Side,
  round: Schema.Int.pipe(Schema.positive()),
  turn: Schema.Int.pipe(Schema.positive()),
  scores: Scores,
  self: PrivateFighter,
  opponent: PublicFighter,
  /** 相手の手札合計。手選択中（SELECTING / EXTRA_SELECTING）だけ送る。 */
  opponentHandTotal: Schema.NullOr(Count),
  /** Python「動的型付け」発動後だけ送る、相手の手札内訳。 */
  opponentRevealedHand: Schema.NullOr(Hand),
  /** 今出せる手。 */
  playable: Schema.Array(Move),
  /** 自分が手を確定したか／相手が確定したか（手の中身は送らない）。 */
  selected: Schema.Struct({ you: Schema.Boolean, opponent: Schema.Boolean }),
  /** 自分がイベントループの追加の 1 手を選ぶ番か。 */
  extraForYou: Schema.Boolean,
  /** 締め切りまでの残り ms（サーバーの時計で計算。表示用で、判定はサーバーが行う）。 */
  remainingMs: Schema.NullOr(Count),
  connected: Schema.Struct({ P1: Schema.Boolean, P2: Schema.Boolean }),
});

export const SyncState = Schema.Union(LobbySync, MatchSync);
export type SyncState = typeof SyncState.Type;

export const ErrorCode = Schema.Literal(
  "RoomNotFound",
  "RoomFull",
  "InvalidTransition",
  "StaleTurn",
  "NotYourTurn",
  "InvalidSequence",
  "RateLimited",
  "SessionExpired",
  "InvalidMessage",
  "VersionMismatch",
);
export type ErrorCode = typeof ErrorCode.Type;

// ---------------------------------------------------------------------------
// サーバー → クライアント
// ---------------------------------------------------------------------------

export const ServerMessage = Schema.Union(
  Schema.TaggedStruct("RoomJoined", {
    roomCode: RoomCode,
    playerId: Side,
    sessionToken: SessionToken,
    opponent: Schema.NullOr(Schema.Struct({ characterId: CharacterIdString })),
    serverSeq: Seq,
  }),
  Schema.TaggedStruct("MoveAccepted", {
    matchId: MatchId,
    turn: Schema.Int.pipe(Schema.positive()),
    extra: Schema.Boolean,
    serverSeq: Seq,
  }),
  /** 1 ターンの結果。両者に同じ内容をアトミックに一斉配信する（INV-7）。 */
  Schema.TaggedStruct("TurnResolved", {
    matchId: MatchId,
    turn: Schema.Int.pipe(Schema.positive()),
    round: Schema.Int.pipe(Schema.positive()),
    p1: PublicFighter,
    p2: PublicFighter,
    outcome: Outcome,
    events: Schema.Array(PublicEvent),
    roundResult: Schema.NullOr(RoundResult),
    scores: Scores,
    serverSeq: Seq,
  }),
  Schema.TaggedStruct("SkillActivated", {
    player: Side,
    skillId: SkillId,
    skillName: Schema.String,
    effect: PublicActivation,
    turn: Schema.Int.pipe(Schema.positive()),
    serverSeq: Seq,
  }),
  Schema.TaggedStruct("HiddenTraitTriggered", {
    player: Side,
    achievementId: Schema.String,
    displayName: Schema.String,
    turn: Schema.Int.pipe(Schema.positive()),
    serverSeq: Seq,
  }),
  Schema.TaggedStruct("MatchFinished", {
    matchId: MatchId,
    winner: Side,
    scores: Scores,
    /** 降参・切断による決着か。 */
    reason: Schema.Literal("Decided", "Forfeit", "Disconnected"),
    serverSeq: Seq,
  }),
  Schema.TaggedStruct("StateSync", { matchId: Schema.NullOr(MatchId), state: SyncState, serverSeq: Seq }),
  Schema.TaggedStruct("Error", { code: ErrorCode, message: Schema.String, serverSeq: Seq }),
);
export type ServerMessage = typeof ServerMessage.Type;

/** serverSeq を付ける前のサーバーメッセージ（serverSeq は接続ごとの送信時に採番する）。 */
export type ServerPayload = ServerMessage extends infer M ? (M extends unknown ? Omit<M, "serverSeq"> : never) : never;

export const decodeClientMessage = Schema.decodeUnknown(Schema.parseJson(ClientMessage));
export const encodeClientMessage = Schema.encode(Schema.parseJson(ClientMessage));
export const decodeServerMessage = Schema.decodeUnknown(Schema.parseJson(ServerMessage));
export const encodeServerMessage = Schema.encode(Schema.parseJson(ServerMessage));
