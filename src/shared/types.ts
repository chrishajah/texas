export type Suit = "s" | "h" | "d" | "c";
export type Rank = "A" | "K" | "Q" | "J" | "T" | "9" | "8" | "7" | "6" | "5" | "4" | "3" | "2";
export type Card = `${Rank}${Suit}`;

export type GamePhase = "waiting" | "preflop" | "flop" | "turn" | "river" | "showdown" | "handComplete";

export type ClientToServerEvents = {
  "room:join": (
    payload: { roomId: string; nickname: string; token: string },
    ack?: (response: JoinAck) => void
  ) => void;
  "seat:take": (payload: { roomId: string; seatIndex: number }) => void;
  "seat:leave": (payload: { roomId: string }) => void;
  "game:start": (payload: { roomId: string }) => void;
  "game:nextHand": (payload: { roomId: string }) => void;
  "action:fold": (payload: { roomId: string }) => void;
  "action:checkCall": (payload: { roomId: string }) => void;
  "action:betRaise": (payload: { roomId: string; amount: number }) => void;
  "action:allIn": (payload: { roomId: string }) => void;
};

export type ServerToClientEvents = {
  "room:state": (state: PublicRoomState) => void;
  "room:error": (error: { message: string }) => void;
  "game:log": (entries: LogEntry[]) => void;
};

export interface JoinAck {
  ok: boolean;
  token?: string;
  playerId?: string;
  message?: string;
}

export interface CreateRoomResponse {
  roomId: string;
  url: string;
}

export interface PublicRoomState {
  roomId: string;
  hostId: string | null;
  you: PublicYou | null;
  seats: Array<PublicSeat | null>;
  phase: GamePhase;
  handNumber: number;
  communityCards: Card[];
  pot: number;
  pots: PublicPot[];
  dealerIndex: number | null;
  smallBlindIndex: number | null;
  bigBlindIndex: number | null;
  currentTurnSeat: number | null;
  highestBet: number;
  minRaiseTo: number | null;
  actionDeadlineAt: number | null;
  canStart: boolean;
  legalActions: LegalActions;
  logs: LogEntry[];
  settings: TableSettings;
}

export interface PublicYou {
  playerId: string;
  nickname: string;
  token: string;
  seatIndex: number | null;
  isHost: boolean;
}

export interface PublicSeat {
  seatIndex: number;
  playerId: string;
  nickname: string;
  chips: number;
  currentBet: number;
  committed: number;
  folded: boolean;
  allIn: boolean;
  inHand: boolean;
  connected: boolean;
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  isTurn: boolean;
  hasCards: boolean;
  cards: Card[] | null;
  lastAction: string | null;
  handName: string | null;
  handDescription: string | null;
}

export interface PublicPot {
  amount: number;
  eligibleSeatIndexes: number[];
}

export interface LegalActions {
  isYourTurn: boolean;
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canRaise: boolean;
  minRaiseTo: number | null;
  maxRaiseTo: number | null;
  canAllIn: boolean;
}

export interface LogEntry {
  id: string;
  at: number;
  message: string;
}

export interface TableSettings {
  maxSeats: number;
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  actionSeconds: number;
}
