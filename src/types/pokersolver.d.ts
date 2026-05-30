declare module "pokersolver" {
  export class Hand {
    static solve(cards: string[], game?: string, canDisqualify?: boolean): SolvedHand;
    static winners(hands: SolvedHand[]): SolvedHand[];
  }

  export interface SolvedHand {
    name: string;
    descr: string;
    rank: number;
    cards: Array<{ value: string; suit: string }>;
    cardPool: Array<{ value: string; suit: string }>;
    toString(): string;
  }
}
