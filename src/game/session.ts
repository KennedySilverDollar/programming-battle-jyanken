import { Option } from "effect";
import type { GameData } from "../core/gameData";
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
