import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type {
  Card,
  GamePhase,
  LegalActions,
  LogEntry,
  PublicPot,
  PublicRoomState,
  Rank,
  Suit,
  TableSettings
} from "../shared/types.js";
import type { SolvedHand } from "pokersolver";

const require = createRequire(import.meta.url);
const { Hand } = require("pokersolver") as {
  Hand: {
    solve(cards: string[], game?: string, canDisqualify?: boolean): SolvedHand;
    winners(hands: SolvedHand[]): SolvedHand[];
  };
};

export const TABLE_SETTINGS: TableSettings = {
  maxSeats: 6,
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  actionSeconds: 30
};

const RANKS: Rank[] = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
const SUITS: Suit[] = ["s", "h", "d", "c"];
const ACTIVE_PHASES: GamePhase[] = ["preflop", "flop", "turn", "river"];
const MAX_LOGS = 80;

export interface PlayerRecord {
  id: string;
  token: string;
  nickname: string;
  socketIds: Set<string>;
  connected: boolean;
}

export interface SeatState {
  playerId: string;
  nickname: string;
  chips: number;
  connected: boolean;
  cards: Card[];
  currentBet: number;
  committed: number;
  folded: boolean;
  allIn: boolean;
  inHand: boolean;
  hasActed: boolean;
  lastAction: string | null;
  handName: string | null;
  handDescription: string | null;
}

export interface RoomState {
  id: string;
  hostId: string | null;
  players: Map<string, PlayerRecord>;
  playerIdByToken: Map<string, string>;
  seats: Array<SeatState | null>;
  phase: GamePhase;
  handNumber: number;
  deck: Card[];
  communityCards: Card[];
  dealerIndex: number | null;
  smallBlindIndex: number | null;
  bigBlindIndex: number | null;
  currentTurnSeat: number | null;
  highestBet: number;
  lastRaiseSize: number;
  actionDeadlineAt: number | null;
  showdownSeatIndexes: number[];
  logs: LogEntry[];
  createdAt: number;
  lastActiveAt: number;
  rng: () => number;
  actionTimer?: ReturnType<typeof setTimeout>;
}

export type PlayerAction =
  | { type: "fold" }
  | { type: "checkCall" }
  | { type: "betRaise"; amount: number }
  | { type: "allIn" };

export function createRoom(id = createRoomId(), rng: () => number = Math.random): RoomState {
  const now = Date.now();

  return {
    id,
    hostId: null,
    players: new Map(),
    playerIdByToken: new Map(),
    seats: Array.from({ length: TABLE_SETTINGS.maxSeats }, () => null),
    phase: "waiting",
    handNumber: 0,
    deck: [],
    communityCards: [],
    dealerIndex: null,
    smallBlindIndex: null,
    bigBlindIndex: null,
    currentTurnSeat: null,
    highestBet: 0,
    lastRaiseSize: TABLE_SETTINGS.bigBlind,
    actionDeadlineAt: null,
    showdownSeatIndexes: [],
    logs: [],
    createdAt: now,
    lastActiveAt: now,
    rng
  };
}

export function createRoomId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

export function joinRoom(room: RoomState, nickname: string, token: string): PlayerRecord {
  const cleanNickname = normalizeNickname(nickname);
  const cleanToken = token.trim();

  if (!cleanToken) {
    throw new Error("缺少玩家身份，请刷新后重试。");
  }

  const existingPlayerId = room.playerIdByToken.get(cleanToken);
  if (existingPlayerId) {
    const existing = mustGetPlayer(room, existingPlayerId);
    existing.nickname = cleanNickname;
    existing.connected = true;
    const seatIndex = findSeatIndexByPlayer(room, existing.id);
    if (seatIndex !== null) {
      const seat = room.seats[seatIndex];
      if (seat) {
        seat.nickname = cleanNickname;
        seat.connected = true;
      }
    }
    touch(room);
    return existing;
  }

  const player: PlayerRecord = {
    id: randomUUID(),
    token: cleanToken,
    nickname: cleanNickname,
    socketIds: new Set(),
    connected: true
  };

  room.players.set(player.id, player);
  room.playerIdByToken.set(cleanToken, player.id);
  if (!room.hostId) {
    room.hostId = player.id;
    addLog(room, `${player.nickname} 创建了牌桌`);
  } else {
    addLog(room, `${player.nickname} 加入了房间`);
  }

  touch(room);
  return player;
}

export function takeSeat(room: RoomState, playerId: string, seatIndex: number): void {
  assertSeatIndex(seatIndex);
  const player = mustGetPlayer(room, playerId);

  if (!["waiting", "handComplete"].includes(room.phase)) {
    throw new Error("当前手牌进行中，结束后才能坐下或换座。");
  }

  const target = room.seats[seatIndex];
  if (target && target.playerId !== playerId) {
    throw new Error("这个座位已经有人了。");
  }

  const previousSeatIndex = findSeatIndexByPlayer(room, playerId);
  const preservedChips = previousSeatIndex !== null ? room.seats[previousSeatIndex]?.chips : undefined;
  if (previousSeatIndex !== null && previousSeatIndex !== seatIndex) {
    room.seats[previousSeatIndex] = null;
  }

  room.seats[seatIndex] = {
    playerId,
    nickname: player.nickname,
    chips: preservedChips ?? target?.chips ?? TABLE_SETTINGS.startingStack,
    connected: player.connected,
    cards: [],
    currentBet: 0,
    committed: 0,
    folded: false,
    allIn: false,
    inHand: false,
    hasActed: false,
    lastAction: null,
    handName: null,
    handDescription: null
  };

  addLog(room, `${player.nickname} 坐到 ${seatIndex + 1} 号位`);
  touch(room);
}

export function leaveSeat(room: RoomState, playerId: string): void {
  if (!["waiting", "handComplete"].includes(room.phase)) {
    throw new Error("当前手牌进行中，结束后才能离座。");
  }

  const seatIndex = findSeatIndexByPlayer(room, playerId);
  if (seatIndex === null) {
    return;
  }

  const seat = room.seats[seatIndex];
  room.seats[seatIndex] = null;
  if (seat) {
    addLog(room, `${seat.nickname} 离开座位`);
  }
  touch(room);
}

export function markPlayerConnection(room: RoomState, playerId: string, connected: boolean): void {
  const player = room.players.get(playerId);
  if (!player) {
    return;
  }

  player.connected = connected;
  const seatIndex = findSeatIndexByPlayer(room, playerId);
  if (seatIndex !== null) {
    const seat = room.seats[seatIndex];
    if (seat) {
      seat.connected = connected;
    }
  }
  touch(room);
}

export function startHand(room: RoomState, requestedByPlayerId: string): void {
  if (room.hostId !== requestedByPlayerId) {
    throw new Error("只有房主可以开始下一手。");
  }

  if (!["waiting", "handComplete"].includes(room.phase)) {
    throw new Error("当前手牌还没有结束。");
  }

  const activeIndexes = seatedIndexes(room).filter((index) => {
    const seat = room.seats[index];
    return Boolean(seat && seat.chips > 0);
  });

  if (activeIndexes.length < 2) {
    throw new Error("至少需要 2 名有筹码的玩家坐下。");
  }

  clearTransientHandState(room);
  room.handNumber += 1;
  room.phase = "preflop";
  room.deck = shuffle(createDeck(), room.rng);
  room.communityCards = [];
  room.highestBet = 0;
  room.lastRaiseSize = TABLE_SETTINGS.bigBlind;
  room.actionDeadlineAt = null;
  room.showdownSeatIndexes = [];

  for (const index of activeIndexes) {
    const seat = mustGetSeat(room, index);
    seat.inHand = true;
  }

  room.dealerIndex = chooseNextDealer(room, activeIndexes);
  if (activeIndexes.length === 2) {
    room.smallBlindIndex = room.dealerIndex;
    room.bigBlindIndex = nextActiveSeat(activeIndexes, room.smallBlindIndex);
  } else {
    room.smallBlindIndex = nextActiveSeat(activeIndexes, room.dealerIndex);
    room.bigBlindIndex = nextActiveSeat(activeIndexes, room.smallBlindIndex);
  }

  const dealOrder = orderedActiveSeats(activeIndexes, room.smallBlindIndex);
  for (let round = 0; round < 2; round += 1) {
    for (const index of dealOrder) {
      mustGetSeat(room, index).cards.push(drawCard(room));
    }
  }

  addLog(room, `第 ${room.handNumber} 手牌开始`);
  postBlind(room, room.smallBlindIndex, TABLE_SETTINGS.smallBlind, "小盲");
  postBlind(room, room.bigBlindIndex, TABLE_SETTINGS.bigBlind, "大盲");

  room.currentTurnSeat = findNextNeedingAction(room, room.bigBlindIndex);
  advanceAfterMutation(room, room.bigBlindIndex);
  touch(room);
}

export function applyAction(room: RoomState, playerId: string, action: PlayerAction): void {
  if (!ACTIVE_PHASES.includes(room.phase)) {
    throw new Error("当前没有可操作的手牌。");
  }

  const seatIndex = findSeatIndexByPlayer(room, playerId);
  if (seatIndex === null || seatIndex !== room.currentTurnSeat) {
    throw new Error("还没轮到你行动。");
  }

  const seat = mustGetSeat(room, seatIndex);
  if (!seat.inHand || seat.folded || seat.allIn) {
    throw new Error("当前座位不能行动。");
  }

  if (action.type === "fold") {
    seat.folded = true;
    seat.hasActed = true;
    seat.lastAction = "弃牌";
    addLog(room, `${seat.nickname} 弃牌`);
  }

  if (action.type === "checkCall") {
    const toCall = Math.max(0, room.highestBet - seat.currentBet);
    if (toCall === 0) {
      seat.hasActed = true;
      seat.lastAction = "过牌";
      addLog(room, `${seat.nickname} 过牌`);
    } else {
      const paid = commitChips(seat, toCall);
      seat.hasActed = true;
      seat.lastAction = paid < toCall ? `全下跟注 ${paid}` : `跟注 ${paid}`;
      addLog(room, `${seat.nickname} ${seat.lastAction}`);
    }
  }

  if (action.type === "betRaise") {
    const totalBet = Math.floor(action.amount);
    const legal = getLegalActionsForSeat(room, seatIndex);
    if (!legal.canRaise || legal.minRaiseTo === null || legal.maxRaiseTo === null) {
      throw new Error("当前不能下注或加注。");
    }
    if (totalBet < legal.minRaiseTo || totalBet > legal.maxRaiseTo) {
      throw new Error(`下注金额需要在 ${legal.minRaiseTo} 到 ${legal.maxRaiseTo} 之间。`);
    }

    const oldHighestBet = room.highestBet;
    const additional = totalBet - seat.currentBet;
    commitChips(seat, additional);
    registerRaise(room, seatIndex, oldHighestBet, seat.currentBet);
    seat.hasActed = true;
    seat.lastAction = oldHighestBet === 0 ? `下注 ${seat.currentBet}` : `加注到 ${seat.currentBet}`;
    addLog(room, `${seat.nickname} ${seat.lastAction}`);
  }

  if (action.type === "allIn") {
    if (seat.chips <= 0) {
      throw new Error("没有可全下的筹码。");
    }

    const oldHighestBet = room.highestBet;
    const paid = commitChips(seat, seat.chips);
    if (seat.currentBet > oldHighestBet) {
      registerRaise(room, seatIndex, oldHighestBet, seat.currentBet);
    }
    seat.hasActed = true;
    seat.lastAction = seat.currentBet > oldHighestBet ? `全下到 ${seat.currentBet}` : `全下跟注 ${paid}`;
    addLog(room, `${seat.nickname} ${seat.lastAction}`);
  }

  advanceAfterMutation(room, seatIndex);
  touch(room);
}

export function getPublicState(room: RoomState, viewerPlayerId: string | null): PublicRoomState {
  const viewerSeatIndex = viewerPlayerId ? findSeatIndexByPlayer(room, viewerPlayerId) : null;
  const viewer = viewerPlayerId ? room.players.get(viewerPlayerId) ?? null : null;

  return {
    roomId: room.id,
    hostId: room.hostId,
    you: viewer
      ? {
          playerId: viewer.id,
          nickname: viewer.nickname,
          token: viewer.token,
          seatIndex: viewerSeatIndex,
          isHost: viewer.id === room.hostId
        }
      : null,
    seats: room.seats.map((seat, seatIndex) => {
      if (!seat) {
        return null;
      }

      const shouldReveal =
        seat.playerId === viewerPlayerId ||
        (room.phase === "handComplete" && room.showdownSeatIndexes.includes(seatIndex));

      return {
        seatIndex,
        playerId: seat.playerId,
        nickname: seat.nickname,
        chips: seat.chips,
        currentBet: seat.currentBet,
        committed: seat.committed,
        folded: seat.folded,
        allIn: seat.allIn,
        inHand: seat.inHand,
        connected: seat.connected,
        isDealer: seatIndex === room.dealerIndex,
        isSmallBlind: seatIndex === room.smallBlindIndex,
        isBigBlind: seatIndex === room.bigBlindIndex,
        isTurn: seatIndex === room.currentTurnSeat,
        hasCards: seat.cards.length > 0,
        cards: shouldReveal && seat.cards.length > 0 ? seat.cards : null,
        lastAction: seat.lastAction,
        handName: shouldReveal ? seat.handName : null,
        handDescription: shouldReveal ? seat.handDescription : null
      };
    }),
    phase: room.phase,
    handNumber: room.handNumber,
    communityCards: room.communityCards,
    pot: totalPot(room),
    pots: buildPots(room),
    dealerIndex: room.dealerIndex,
    smallBlindIndex: room.smallBlindIndex,
    bigBlindIndex: room.bigBlindIndex,
    currentTurnSeat: room.currentTurnSeat,
    highestBet: room.highestBet,
    minRaiseTo: getRoomMinRaiseTo(room),
    actionDeadlineAt: room.actionDeadlineAt,
    canStart: ["waiting", "handComplete"].includes(room.phase) && seatedIndexes(room).filter((index) => {
      const seat = room.seats[index];
      return Boolean(seat && seat.chips > 0);
    }).length >= 2,
    legalActions:
      viewerSeatIndex !== null ? getLegalActionsForSeat(room, viewerSeatIndex) : emptyLegalActions(false),
    logs: room.logs.slice(-MAX_LOGS),
    settings: TABLE_SETTINGS
  };
}

export function getLegalActionsForSeat(room: RoomState, seatIndex: number): LegalActions {
  const seat = room.seats[seatIndex];
  if (!seat) {
    return emptyLegalActions(false);
  }

  const isYourTurn =
    ACTIVE_PHASES.includes(room.phase) &&
    room.currentTurnSeat === seatIndex &&
    !seat.folded &&
    !seat.allIn &&
    seat.inHand;

  if (!isYourTurn) {
    return emptyLegalActions(false);
  }

  const callAmount = Math.max(0, Math.min(seat.chips, room.highestBet - seat.currentBet));
  const maxRaiseTo = seat.currentBet + seat.chips;
  const minRaiseTo = getMinimumRaiseTo(room);
  const canRaise = seat.chips > callAmount && minRaiseTo !== null && maxRaiseTo >= minRaiseTo;

  return {
    isYourTurn,
    canFold: true,
    canCheck: callAmount === 0,
    canCall: callAmount > 0,
    callAmount,
    canRaise,
    minRaiseTo: canRaise ? minRaiseTo : null,
    maxRaiseTo: canRaise ? maxRaiseTo : null,
    canAllIn: seat.chips > 0
  };
}

export function createDeck(): Card[] {
  const cards: Card[] = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      cards.push(`${rank}${suit}`);
    }
  }
  return cards;
}

export function buildPots(room: RoomState): PublicPot[] {
  const committedLevels = Array.from(
    new Set(
      room.seats
        .map((seat) => seat?.committed ?? 0)
        .filter((amount) => amount > 0)
    )
  ).sort((a, b) => a - b);

  const pots: PublicPot[] = [];
  let previousLevel = 0;
  for (const level of committedLevels) {
    const contributors = room.seats
      .map((seat, index) => ({ seat, index }))
      .filter(({ seat }) => seat && seat.committed >= level);
    const amount = (level - previousLevel) * contributors.length;
    const eligibleSeatIndexes = contributors
      .filter(({ seat }) => seat && seat.inHand && !seat.folded)
      .map(({ index }) => index);

    if (amount > 0 && eligibleSeatIndexes.length > 0) {
      pots.push({ amount, eligibleSeatIndexes });
    }
    previousLevel = level;
  }

  return pots;
}

function normalizeNickname(nickname: string): string {
  const cleanNickname = nickname.trim().replace(/\s+/g, " ").slice(0, 18);
  if (!cleanNickname) {
    throw new Error("请输入昵称。");
  }
  return cleanNickname;
}

function assertSeatIndex(seatIndex: number): void {
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= TABLE_SETTINGS.maxSeats) {
    throw new Error("座位不存在。");
  }
}

function mustGetPlayer(room: RoomState, playerId: string): PlayerRecord {
  const player = room.players.get(playerId);
  if (!player) {
    throw new Error("玩家不存在或尚未加入房间。");
  }
  return player;
}

function mustGetSeat(room: RoomState, seatIndex: number): SeatState {
  const seat = room.seats[seatIndex];
  if (!seat) {
    throw new Error("座位为空。");
  }
  return seat;
}

function touch(room: RoomState): void {
  room.lastActiveAt = Date.now();
}

function addLog(room: RoomState, message: string): void {
  room.logs.push({
    id: randomUUID(),
    at: Date.now(),
    message
  });
  if (room.logs.length > MAX_LOGS) {
    room.logs.splice(0, room.logs.length - MAX_LOGS);
  }
}

function seatedIndexes(room: RoomState): number[] {
  return room.seats
    .map((seat, index) => ({ seat, index }))
    .filter(({ seat }) => Boolean(seat))
    .map(({ index }) => index);
}

function activeContenderIndexes(room: RoomState): number[] {
  return room.seats
    .map((seat, index) => ({ seat, index }))
    .filter(({ seat }) => seat && seat.inHand && !seat.folded)
    .map(({ index }) => index);
}

function activeActorIndexes(room: RoomState): number[] {
  return room.seats
    .map((seat, index) => ({ seat, index }))
    .filter(({ seat }) => seat && seat.inHand && !seat.folded && !seat.allIn && seat.chips > 0)
    .map(({ index }) => index);
}

function findSeatIndexByPlayer(room: RoomState, playerId: string): number | null {
  const index = room.seats.findIndex((seat) => seat?.playerId === playerId);
  return index >= 0 ? index : null;
}

function clearTransientHandState(room: RoomState): void {
  for (const seat of room.seats) {
    if (!seat) {
      continue;
    }

    seat.cards = [];
    seat.currentBet = 0;
    seat.committed = 0;
    seat.folded = false;
    seat.allIn = false;
    seat.inHand = false;
    seat.hasActed = false;
    seat.lastAction = null;
    seat.handName = null;
    seat.handDescription = null;
  }

  room.currentTurnSeat = null;
  room.smallBlindIndex = null;
  room.bigBlindIndex = null;
}

function shuffle(cards: Card[], rng: () => number): Card[] {
  const shuffled = [...cards];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function chooseNextDealer(room: RoomState, activeIndexes: number[]): number {
  if (room.dealerIndex === null || !activeIndexes.includes(room.dealerIndex)) {
    return activeIndexes[0];
  }

  return nextActiveSeat(activeIndexes, room.dealerIndex);
}

function nextActiveSeat(activeIndexes: number[], fromSeatIndex: number): number {
  for (let offset = 1; offset <= TABLE_SETTINGS.maxSeats; offset += 1) {
    const candidate = (fromSeatIndex + offset) % TABLE_SETTINGS.maxSeats;
    if (activeIndexes.includes(candidate)) {
      return candidate;
    }
  }

  throw new Error("找不到下一位玩家。");
}

function orderedActiveSeats(activeIndexes: number[], firstSeatIndex: number): number[] {
  const ordered: number[] = [];
  for (let offset = 0; offset < TABLE_SETTINGS.maxSeats; offset += 1) {
    const candidate = (firstSeatIndex + offset) % TABLE_SETTINGS.maxSeats;
    if (activeIndexes.includes(candidate)) {
      ordered.push(candidate);
    }
  }
  return ordered;
}

function drawCard(room: RoomState): Card {
  const card = room.deck.pop();
  if (!card) {
    throw new Error("牌堆已经为空。");
  }
  return card;
}

function postBlind(room: RoomState, seatIndex: number | null, blindAmount: number, label: string): void {
  if (seatIndex === null) {
    return;
  }

  const seat = mustGetSeat(room, seatIndex);
  const paid = commitChips(seat, blindAmount);
  room.highestBet = Math.max(room.highestBet, seat.currentBet);
  room.lastRaiseSize = TABLE_SETTINGS.bigBlind;
  seat.lastAction = `${label} ${paid}`;
  addLog(room, `${seat.nickname} 下${label} ${paid}`);
}

function commitChips(seat: SeatState, requestedAmount: number): number {
  const amount = Math.max(0, Math.min(seat.chips, Math.floor(requestedAmount)));
  seat.chips -= amount;
  seat.currentBet += amount;
  seat.committed += amount;
  if (seat.chips === 0) {
    seat.allIn = true;
  }
  return amount;
}

function registerRaise(room: RoomState, actorSeatIndex: number, oldHighestBet: number, newHighestBet: number): void {
  if (newHighestBet <= oldHighestBet) {
    throw new Error("加注金额必须超过当前最高下注。");
  }

  const raiseSize = newHighestBet - oldHighestBet;
  room.highestBet = newHighestBet;
  room.lastRaiseSize = Math.max(raiseSize, TABLE_SETTINGS.bigBlind);

  for (const index of activeActorIndexes(room)) {
    if (index !== actorSeatIndex) {
      const seat = mustGetSeat(room, index);
      seat.hasActed = false;
    }
  }
}

function advanceAfterMutation(room: RoomState, fromSeatIndex: number | null): void {
  if (!ACTIVE_PHASES.includes(room.phase)) {
    return;
  }

  const contenders = activeContenderIndexes(room);
  if (contenders.length === 1) {
    awardUncontested(room, contenders[0]);
    return;
  }

  if (isBettingRoundComplete(room)) {
    const actorsWithChips = activeActorIndexes(room);
    if (actorsWithChips.length <= 1) {
      dealRemainingBoard(room);
      settleShowdown(room);
      return;
    }

    advanceStreet(room);
    return;
  }

  room.currentTurnSeat = findNextNeedingAction(room, fromSeatIndex);
  setActionDeadline(room);
}

function isBettingRoundComplete(room: RoomState): boolean {
  const contenders = activeContenderIndexes(room);
  if (contenders.length <= 1) {
    return true;
  }

  return contenders.every((index) => {
    const seat = mustGetSeat(room, index);
    if (seat.allIn || seat.chips === 0) {
      return true;
    }

    return seat.hasActed && seat.currentBet === room.highestBet;
  });
}

function findNextNeedingAction(room: RoomState, fromSeatIndex: number | null): number | null {
  const start = fromSeatIndex ?? room.dealerIndex ?? 0;
  for (let offset = 1; offset <= TABLE_SETTINGS.maxSeats; offset += 1) {
    const candidate = (start + offset) % TABLE_SETTINGS.maxSeats;
    const seat = room.seats[candidate];
    if (
      seat &&
      seat.inHand &&
      !seat.folded &&
      !seat.allIn &&
      seat.chips > 0 &&
      (!seat.hasActed || seat.currentBet < room.highestBet)
    ) {
      return candidate;
    }
  }

  return null;
}

function advanceStreet(room: RoomState): void {
  for (const seat of room.seats) {
    if (!seat) {
      continue;
    }
    seat.currentBet = 0;
    seat.hasActed = false;
  }

  room.highestBet = 0;
  room.lastRaiseSize = TABLE_SETTINGS.bigBlind;

  if (room.phase === "preflop") {
    room.phase = "flop";
    room.communityCards.push(drawCard(room), drawCard(room), drawCard(room));
    addLog(room, `翻牌：${formatCards(room.communityCards.slice(-3))}`);
  } else if (room.phase === "flop") {
    room.phase = "turn";
    room.communityCards.push(drawCard(room));
    addLog(room, `转牌：${formatCards(room.communityCards.slice(-1))}`);
  } else if (room.phase === "turn") {
    room.phase = "river";
    room.communityCards.push(drawCard(room));
    addLog(room, `河牌：${formatCards(room.communityCards.slice(-1))}`);
  } else if (room.phase === "river") {
    settleShowdown(room);
    return;
  }

  if (activeActorIndexes(room).length <= 1) {
    dealRemainingBoard(room);
    settleShowdown(room);
    return;
  }

  room.currentTurnSeat = findNextNeedingAction(room, room.dealerIndex);
  setActionDeadline(room);
}

function dealRemainingBoard(room: RoomState): void {
  const before = room.communityCards.length;
  while (room.communityCards.length < 5) {
    room.communityCards.push(drawCard(room));
  }

  if (room.communityCards.length > before) {
    addLog(room, `公共牌发完：${formatCards(room.communityCards.slice(before))}`);
  }
}

function awardUncontested(room: RoomState, winnerSeatIndex: number): void {
  const winner = mustGetSeat(room, winnerSeatIndex);
  const pot = totalPot(room);
  winner.chips += pot;
  winner.lastAction = `赢得 ${pot}`;
  room.currentTurnSeat = null;
  room.actionDeadlineAt = null;
  room.showdownSeatIndexes = [];
  room.phase = "handComplete";
  addLog(room, `${winner.nickname} 赢得底池 ${pot}`);
}

function settleShowdown(room: RoomState): void {
  const contenders = activeContenderIndexes(room);
  if (contenders.length === 0) {
    room.phase = "handComplete";
    room.currentTurnSeat = null;
    room.actionDeadlineAt = null;
    return;
  }

  const solvedBySeat = new Map<number, SolvedHand>();
  for (const index of contenders) {
    const seat = mustGetSeat(room, index);
    const solved = Hand.solve([...seat.cards, ...room.communityCards], "standard");
    solvedBySeat.set(index, solved);
    seat.handName = solved.name;
    seat.handDescription = solved.descr;
  }

  const pots = buildPots(room);
  for (const pot of pots) {
    const eligibleHands = pot.eligibleSeatIndexes.map((index) => solvedBySeat.get(index)).filter(Boolean) as SolvedHand[];
    const winningHands = Hand.winners(eligibleHands);
    const winnerIndexes = pot.eligibleSeatIndexes.filter((index) => {
      const hand = solvedBySeat.get(index);
      return hand ? winningHands.includes(hand) : false;
    });
    const share = Math.floor(pot.amount / winnerIndexes.length);
    const remainder = pot.amount % winnerIndexes.length;

    winnerIndexes
      .slice()
      .sort((a, b) => a - b)
      .forEach((winnerIndex, order) => {
        const seat = mustGetSeat(room, winnerIndex);
        seat.chips += share + (order < remainder ? 1 : 0);
      });

    const winnerNames = winnerIndexes.map((index) => mustGetSeat(room, index).nickname).join("、");
    addLog(room, `${winnerNames} 赢得 ${pot.amount}`);
  }

  room.showdownSeatIndexes = contenders;
  room.currentTurnSeat = null;
  room.actionDeadlineAt = null;
  room.phase = "handComplete";
}

function totalPot(room: RoomState): number {
  return room.seats.reduce((sum, seat) => sum + (seat?.committed ?? 0), 0);
}

function setActionDeadline(room: RoomState): void {
  room.actionDeadlineAt = room.currentTurnSeat === null ? null : Date.now() + TABLE_SETTINGS.actionSeconds * 1000;
}

function getMinimumRaiseTo(room: RoomState): number | null {
  if (!ACTIVE_PHASES.includes(room.phase)) {
    return null;
  }

  if (room.highestBet === 0) {
    return TABLE_SETTINGS.bigBlind;
  }

  return room.highestBet + room.lastRaiseSize;
}

function getRoomMinRaiseTo(room: RoomState): number | null {
  if (room.currentTurnSeat === null) {
    return null;
  }

  return getLegalActionsForSeat(room, room.currentTurnSeat).minRaiseTo;
}

function emptyLegalActions(isYourTurn: boolean): LegalActions {
  return {
    isYourTurn,
    canFold: false,
    canCheck: false,
    canCall: false,
    callAmount: 0,
    canRaise: false,
    minRaiseTo: null,
    maxRaiseTo: null,
    canAllIn: false
  };
}

function formatCards(cards: Card[]): string {
  return cards.join(" ");
}
