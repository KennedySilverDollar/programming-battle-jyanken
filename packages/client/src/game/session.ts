import { type Layer, Option } from "effect";
import type { AchievementStore } from "@pbj/shared/achievements";
import type { GameData } from "@pbj/shared/gameData";
import type { Matchup } from "./selectState";

/**
 * Scene 間で共有する型付きの状態（Phaser の scene.start のデータは型が付かないため）。
 * ゲームロジックの状態ではなく、「次にどの対戦を始めるか」とシードだけを持つ。
 */
export class GameSession {
  private matchup: Option.Option<Matchup>;
  private seedCounter = 0;
  /** URL で対戦カードが指定されていれば、初回だけ選択画面を飛ばす。 */
  private autoStart: boolean;

  constructor(
    readonly data: GameData,
    private readonly baseSeed: number,
    preset: Option.Option<Matchup>,
    /** 実績の保存先（本番はローカルストレージ）。 */
    readonly achievementStore: Layer.Layer<AchievementStore>,
    /** 開発用：確率判定を固定する。本番ビルドでは常に None。 */
    readonly forcedChance: Option.Option<"always" | "never"> = Option.none(),
  ) {
    this.matchup = preset;
    this.autoStart = Option.isSome(preset);
  }

  consumeAutoStart(): boolean {
    const result = this.autoStart;
    this.autoStart = false;
    return result;
  }

  get roster(): GameData["roster"] {
    return this.data.roster;
  }

  currentMatchup(): Option.Option<Matchup> {
    return this.matchup;
  }

  setMatchup(matchup: Matchup): void {
    this.matchup = Option.some(matchup);
  }

  /** 試合ごとに異なる、再現可能なシード。 */
  nextSeed(): number {
    this.seedCounter += 1;
    return this.baseSeed + this.seedCounter;
  }
}
