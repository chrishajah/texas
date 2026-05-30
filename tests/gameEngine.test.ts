import { describe, expect, it } from "vitest";
import {
  applyAction,
  buildPots,
  createDeck,
  createRoom,
  getPublicState,
  joinRoom,
  startHand,
  takeSeat,
  type RoomState
} from "../src/server/gameEngine.js";
import type { Card } from "../src/shared/types.js";

describe("game engine", () => {
  it("creates a unique 52-card deck", () => {
    const deck = createDeck();

    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
  });

  it("posts blinds and sets preflop action order", () => {
    const { room, players } = setupSeatedRoom(3);

    startHand(room, players[0].id);

    expect(room.phase).toBe("preflop");
    expect(room.dealerIndex).toBe(0);
    expect(room.smallBlindIndex).toBe(1);
    expect(room.bigBlindIndex).toBe(2);
    expect(room.currentTurnSeat).toBe(0);
    expect(room.seats[1]?.committed).toBe(5);
    expect(room.seats[2]?.committed).toBe(10);
    expect(room.seats.every((seat) => !seat || new Set(seat.cards).size === seat.cards.length)).toBe(true);
  });

  it("redacts opponents' hole cards before showdown", () => {
    const { room, players } = setupSeatedRoom(2);
    startHand(room, players[0].id);

    const stateForPlayerOne = getPublicState(room, players[0].id);
    const stateForPlayerTwo = getPublicState(room, players[1].id);

    expect(stateForPlayerOne.seats[0]?.cards).toHaveLength(2);
    expect(stateForPlayerOne.seats[1]?.cards).toBeNull();
    expect(stateForPlayerTwo.seats[0]?.cards).toBeNull();
    expect(stateForPlayerTwo.seats[1]?.cards).toHaveLength(2);
  });

  it("advances streets and awards a showdown winner", () => {
    const { room, players } = setupSeatedRoom(2);
    startHand(room, players[0].id);
    forceRiver(room, [
      ["Th", "3d"],
      ["As", "Ac"]
    ]);
    room.communityCards = ["Ah", "Kh", "Qh", "Jh", "2c"];
    room.seats[0]!.committed = 100;
    room.seats[1]!.committed = 100;
    room.seats[0]!.chips = 900;
    room.seats[1]!.chips = 900;
    room.currentTurnSeat = 0;

    applyAction(room, players[0].id, { type: "checkCall" });
    applyAction(room, players[1].id, { type: "checkCall" });

    expect(room.phase).toBe("handComplete");
    expect(room.seats[0]?.chips).toBe(1100);
    expect(room.seats[1]?.chips).toBe(900);
    expect(room.seats[0]?.handDescription).toMatch(/Royal Flush|Straight Flush/);
  });

  it("builds and settles side pots", () => {
    const { room, players } = setupSeatedRoom(3);
    startHand(room, players[0].id);
    forceRiver(room, [
      ["Ah", "Ad"],
      ["Qc", "Qs"],
      ["Jc", "Js"]
    ]);
    room.communityCards = ["2h", "3d", "7s", "9c", "Kd"];
    room.seats[0]!.committed = 50;
    room.seats[0]!.chips = 0;
    room.seats[0]!.allIn = true;
    room.seats[1]!.committed = 100;
    room.seats[1]!.chips = 900;
    room.seats[2]!.committed = 100;
    room.seats[2]!.chips = 900;
    room.currentTurnSeat = 1;

    expect(buildPots(room)).toEqual([
      { amount: 150, eligibleSeatIndexes: [0, 1, 2] },
      { amount: 100, eligibleSeatIndexes: [1, 2] }
    ]);

    applyAction(room, players[1].id, { type: "checkCall" });
    applyAction(room, players[2].id, { type: "checkCall" });

    expect(room.phase).toBe("handComplete");
    expect(room.seats[0]?.chips).toBe(150);
    expect(room.seats[1]?.chips).toBe(1000);
    expect(room.seats[2]?.chips).toBe(900);
  });

  it("rejects illegal raises", () => {
    const { room, players } = setupSeatedRoom(2);
    startHand(room, players[0].id);

    expect(() => applyAction(room, players[0].id, { type: "betRaise", amount: 11 })).toThrow(
      /下注金额/
    );
  });
});

function setupSeatedRoom(playerCount: number) {
  const room = createRoom("test-room", () => 0.42);
  const players = Array.from({ length: playerCount }, (_, index) =>
    joinRoom(room, `玩家${index + 1}`, `token-${index + 1}`)
  );

  players.forEach((player, index) => takeSeat(room, player.id, index));

  return { room, players };
}

function forceRiver(room: RoomState, holeCards: [Card, Card][]): void {
  room.phase = "river";
  room.highestBet = 0;
  room.lastRaiseSize = 10;
  room.actionDeadlineAt = null;
  room.showdownSeatIndexes = [];
  room.deck = createDeck();

  holeCards.forEach((cards, index) => {
    const seat = room.seats[index];
    if (!seat) {
      throw new Error("missing seat");
    }
    seat.cards = cards;
    seat.currentBet = 0;
    seat.folded = false;
    seat.inHand = true;
    seat.hasActed = false;
    seat.lastAction = null;
    seat.handName = null;
    seat.handDescription = null;
  });
}
