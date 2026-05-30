import { afterEach, describe, expect, it } from "vitest";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import request from "supertest";
import { createPokerServer, type PokerServer } from "../src/server/app.js";
import type { PublicRoomState, ServerToClientEvents, ClientToServerEvents } from "../src/shared/types.js";

type TestSocket = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

let server: PokerServer | null = null;
const clients: TestSocket[] = [];

describe("socket integration", () => {
  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.disconnect();
    }
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("creates a room, seats two players, starts a hand, and redacts private cards", async () => {
    server = createPokerServer({ enableTimers: false, enableCleanup: false });
    await listen(server);
    const baseUrl = getBaseUrl(server);
    const response = await request(server.app).post("/api/rooms").expect(201);
    const roomId = response.body.roomId as string;

    const alice = await connectAndJoin(baseUrl, roomId, "Alice", "alice-token");
    const bob = await connectAndJoin(baseUrl, roomId, "Bob", "bob-token");
    clients.push(alice.socket, bob.socket);

    const seatsReady = waitForState(alice.socket, (state) => state.seats.filter(Boolean).length === 2);
    alice.socket.emit("seat:take", { roomId, seatIndex: 0 });
    bob.socket.emit("seat:take", { roomId, seatIndex: 1 });
    await seatsReady;

    const alicePreflop = waitForState(alice.socket, (state) => state.phase === "preflop");
    const bobPreflop = waitForState(bob.socket, (state) => state.phase === "preflop");
    alice.socket.emit("game:start", { roomId });
    const aliceState = await alicePreflop;
    const bobState = await bobPreflop;

    expect(aliceState.you?.isHost).toBe(true);
    expect(aliceState.seats[0]?.cards).toHaveLength(2);
    expect(aliceState.seats[1]?.cards).toBeNull();
    expect(bobState.seats[0]?.cards).toBeNull();
    expect(bobState.seats[1]?.cards).toHaveLength(2);
  });
});

async function listen(target: PokerServer): Promise<void> {
  await new Promise<void>((resolve) => {
    target.httpServer.listen(0, resolve);
  });
}

function getBaseUrl(target: PokerServer): string {
  const address = target.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("server not listening");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function connectAndJoin(baseUrl: string, roomId: string, nickname: string, token: string) {
  const socket: TestSocket = createClient(baseUrl, {
    forceNew: true,
    transports: ["websocket"]
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });

  const joined = waitForState(socket, (state) => state.you?.nickname === nickname);
  const ack = await new Promise<{ ok: boolean; message?: string }>((resolve) => {
    socket.emit("room:join", { roomId, nickname, token }, resolve);
  });
  expect(ack.ok).toBe(true);
  await joined;

  return { socket };
}

function waitForState(socket: TestSocket, predicate: (state: PublicRoomState) => boolean): Promise<PublicRoomState> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("room:state", onState);
      reject(new Error("timed out waiting for room state"));
    }, 1500);

    function onState(state: PublicRoomState) {
      if (!predicate(state)) {
        return;
      }
      clearTimeout(timeout);
      socket.off("room:state", onState);
      resolve(state);
    }

    socket.on("room:state", onState);
  });
}
