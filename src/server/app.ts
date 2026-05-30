import express from "express";
import { createServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import { Server, type Socket } from "socket.io";
import type {
  ClientToServerEvents,
  CreateRoomResponse,
  ServerToClientEvents
} from "../shared/types.js";
import {
  applyAction,
  createRoom,
  getLegalActionsForSeat,
  getPublicState,
  joinRoom,
  leaveSeat,
  markPlayerConnection,
  startHand,
  takeSeat,
  type RoomState
} from "./gameEngine.js";

interface InterServerEvents {
  ping: () => void;
}

interface SocketData {
  roomId?: string;
  playerId?: string;
}

export interface PokerServerOptions {
  clientDist?: string;
  enableTimers?: boolean;
  enableCleanup?: boolean;
  roomTtlMs?: number;
}

export interface PokerServer {
  app: express.Express;
  httpServer: HttpServer;
  io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
  rooms: Map<string, RoomState>;
  close: () => Promise<void>;
}

type PokerSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

const DEFAULT_ROOM_TTL_MS = 1000 * 60 * 60 * 4;

export function createPokerServer(options: PokerServerOptions = {}): PokerServer {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer, {
    cors: {
      origin: true
    }
  });
  const rooms = new Map<string, RoomState>();
  const enableTimers = options.enableTimers ?? true;
  const enableCleanup = options.enableCleanup ?? true;
  const roomTtlMs = options.roomTtlMs ?? DEFAULT_ROOM_TTL_MS;

  app.set("trust proxy", true);
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/rooms", (req, res) => {
    const room = createRoom();
    rooms.set(room.id, room);
    const response: CreateRoomResponse = {
      roomId: room.id,
      url: `${getPublicOrigin(req)}/room/${room.id}`
    };
    res.status(201).json(response);
  });

  io.on("connection", (socket) => {
    socket.on("room:join", (payload, ack) => {
      try {
        const room = mustGetRoom(payload.roomId);
        const beforeLogCount = room.logs.length;
        const player = joinRoom(room, payload.nickname, payload.token);

        if (socket.data.roomId && socket.data.roomId !== room.id) {
          socket.leave(socket.data.roomId);
        }

        socket.data.roomId = room.id;
        socket.data.playerId = player.id;
        player.socketIds.add(socket.id);
        markPlayerConnection(room, player.id, true);
        socket.join(room.id);
        ack?.({ ok: true, token: player.token, playerId: player.id });
        emitRoom(room, beforeLogCount);
      } catch (error) {
        const message = errorMessage(error);
        socket.emit("room:error", { message });
        ack?.({ ok: false, message });
      }
    });

    socket.on("seat:take", (payload) => {
      mutateRoom(socket, payload.roomId, (room, playerId) => {
        takeSeat(room, playerId, payload.seatIndex);
      });
    });

    socket.on("seat:leave", (payload) => {
      mutateRoom(socket, payload.roomId, (room, playerId) => {
        leaveSeat(room, playerId);
      });
    });

    socket.on("game:start", (payload) => {
      mutateRoom(socket, payload.roomId, (room, playerId) => {
        startHand(room, playerId);
      });
    });

    socket.on("game:nextHand", (payload) => {
      mutateRoom(socket, payload.roomId, (room, playerId) => {
        startHand(room, playerId);
      });
    });

    socket.on("action:fold", (payload) => {
      mutateRoom(socket, payload.roomId, (room, playerId) => {
        applyAction(room, playerId, { type: "fold" });
      });
    });

    socket.on("action:checkCall", (payload) => {
      mutateRoom(socket, payload.roomId, (room, playerId) => {
        applyAction(room, playerId, { type: "checkCall" });
      });
    });

    socket.on("action:betRaise", (payload) => {
      mutateRoom(socket, payload.roomId, (room, playerId) => {
        applyAction(room, playerId, { type: "betRaise", amount: payload.amount });
      });
    });

    socket.on("action:allIn", (payload) => {
      mutateRoom(socket, payload.roomId, (room, playerId) => {
        applyAction(room, playerId, { type: "allIn" });
      });
    });

    socket.on("disconnect", () => {
      const { roomId, playerId } = socket.data;
      if (!roomId || !playerId) {
        return;
      }

      const room = rooms.get(roomId);
      const player = room?.players.get(playerId);
      if (!room || !player) {
        return;
      }

      player.socketIds.delete(socket.id);
      if (player.socketIds.size === 0) {
        markPlayerConnection(room, playerId, false);
      }
      emitRoom(room, room.logs.length);
    });
  });

  if (options.clientDist) {
    app.use(express.static(options.clientDist));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(options.clientDist as string, "index.html"));
    });
  }

  const cleanupTimer = enableCleanup
    ? setInterval(() => {
        const now = Date.now();
        for (const [roomId, room] of rooms) {
          const connectedPlayers = Array.from(room.players.values()).filter((player) => player.socketIds.size > 0);
          if (connectedPlayers.length === 0 && now - room.lastActiveAt > roomTtlMs) {
            clearActionTimer(room);
            rooms.delete(roomId);
          }
        }
      }, 1000 * 60 * 15)
    : null;
  cleanupTimer?.unref?.();

  function mustGetRoom(roomId: string): RoomState {
    const room = rooms.get(roomId);
    if (!room) {
      throw new Error("房间不存在或已经过期。");
    }
    return room;
  }

  function mutateRoom(socket: PokerSocket, roomId: string, mutation: (room: RoomState, playerId: string) => void): void {
    try {
      const room = mustGetRoom(roomId);
      const playerId = socket.data.playerId;
      if (!playerId || socket.data.roomId !== room.id) {
        throw new Error("请先加入房间。");
      }
      if (!room.players.has(playerId)) {
        throw new Error("玩家不存在或尚未加入房间。");
      }

      const beforeLogCount = room.logs.length;
      mutation(room, playerId);
      scheduleActionTimer(room);
      emitRoom(room, beforeLogCount);
    } catch (error) {
      socket.emit("room:error", { message: errorMessage(error) });
    }
  }

  function emitRoom(room: RoomState, logStartIndex: number): void {
    const newLogs = room.logs.slice(logStartIndex);
    if (newLogs.length > 0) {
      io.to(room.id).emit("game:log", newLogs);
    }

    for (const player of room.players.values()) {
      for (const socketId of player.socketIds) {
        io.to(socketId).emit("room:state", getPublicState(room, player.id));
      }
    }
  }

  function scheduleActionTimer(room: RoomState): void {
    clearActionTimer(room);
    if (!enableTimers || room.currentTurnSeat === null || room.actionDeadlineAt === null) {
      return;
    }

    const delay = Math.max(0, room.actionDeadlineAt - Date.now());
    room.actionTimer = setTimeout(() => {
      const currentSeatIndex = room.currentTurnSeat;
      if (currentSeatIndex === null) {
        return;
      }

      const seat = room.seats[currentSeatIndex];
      if (!seat) {
        return;
      }

      const beforeLogCount = room.logs.length;
      const legal = getLegalActionsForSeat(room, currentSeatIndex);
      try {
        applyAction(room, seat.playerId, legal.canCheck ? { type: "checkCall" } : { type: "fold" });
      } catch (error) {
        io.to(room.id).emit("room:error", { message: errorMessage(error) });
      }
      scheduleActionTimer(room);
      emitRoom(room, beforeLogCount);
    }, delay + 100);
    room.actionTimer.unref?.();
  }

  function clearActionTimer(room: RoomState): void {
    if (room.actionTimer) {
      clearTimeout(room.actionTimer);
      room.actionTimer = undefined;
    }
  }

  return {
    app,
    httpServer,
    io,
    rooms,
    close: async () => {
      cleanupTimer && clearInterval(cleanupTimer);
      for (const room of rooms.values()) {
        clearActionTimer(room);
      }
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
      if (httpServer.listening) {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  };
}

function getPublicOrigin(req: express.Request): string {
  const forwardedProto = req.get("x-forwarded-proto");
  const forwardedHost = req.get("x-forwarded-host");
  const protocol = forwardedProto?.split(",")[0]?.trim() || req.protocol;
  const host = forwardedHost?.split(",")[0]?.trim() || req.get("host") || "localhost";
  return `${protocol}://${host}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生了未知错误。";
}
