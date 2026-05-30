import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Armchair, CircleDollarSign, Copy, LogOut, Play, Plus, RotateCcw } from "lucide-react";
import { io, type Socket } from "socket.io-client";
import type {
  Card,
  CreateRoomResponse,
  PublicRoomState,
  ServerToClientEvents,
  ClientToServerEvents
} from "../shared/types";
import "./styles.css";

type PokerSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const phaseLabels: Record<PublicRoomState["phase"], string> = {
  waiting: "等待中",
  preflop: "翻牌前",
  flop: "翻牌圈",
  turn: "转牌圈",
  river: "河牌圈",
  showdown: "摊牌",
  handComplete: "本手结束"
};

const rankLabels: Record<string, string> = {
  A: "A",
  K: "K",
  Q: "Q",
  J: "J",
  T: "10",
  "9": "9",
  "8": "8",
  "7": "7",
  "6": "6",
  "5": "5",
  "4": "4",
  "3": "3",
  "2": "2"
};

const suitLabels: Record<string, string> = {
  s: "♠",
  h: "♥",
  d: "♦",
  c: "♣"
};

function App() {
  const roomId = getRoomIdFromPath();
  const socketRef = useRef<PokerSocket | null>(null);
  const previousStateRef = useRef<PublicRoomState | null>(null);
  const animationTimersRef = useRef<number[]>([]);
  const autoJoinAttemptedRef = useRef(false);
  const savedNicknameRef = useRef(localStorage.getItem("texas:nickname") || "");
  const [state, setState] = useState<PublicRoomState | null>(null);
  const [animatedCommunityIndexes, setAnimatedCommunityIndexes] = useState<number[]>([]);
  const [animatedBetSeatIndexes, setAnimatedBetSeatIndexes] = useState<number[]>([]);
  const [potPulseKey, setPotPulseKey] = useState(0);
  const [turnPulseKey, setTurnPulseKey] = useState(0);
  const [nickname, setNickname] = useState(() => savedNicknameRef.current);
  const [isJoining, setIsJoining] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [socketReady, setSocketReady] = useState(false);
  const [joinedRoomId, setJoinedRoomId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [raiseTo, setRaiseTo] = useState(0);

  useEffect(() => {
    if (!roomId) {
      return;
    }

    const socket: PokerSocket = io({ autoConnect: false });
    socketRef.current = socket;
    setSocketReady(false);
    socket.on("connect", () => setSocketReady(true));
    socket.on("disconnect", () => setSocketReady(false));
    socket.on("room:state", (nextState) => {
      queueTableAnimations(previousStateRef.current, nextState, {
        setAnimatedCommunityIndexes,
        setAnimatedBetSeatIndexes,
        setPotPulseKey,
        setTurnPulseKey,
        timers: animationTimersRef.current
      });
      previousStateRef.current = nextState;
      setState(nextState);
      setJoinedRoomId(nextState.roomId);
    });
    socket.on("room:error", (error) => showToast(setToast, error.message));
    socket.on("game:log", () => undefined);
    socket.connect();

    return () => {
      socket.disconnect();
      socketRef.current = null;
      previousStateRef.current = null;
      animationTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      animationTimersRef.current = [];
      setSocketReady(false);
    };
  }, [roomId]);

  useEffect(() => {
    const legal = state?.legalActions;
    if (legal?.canRaise && legal.minRaiseTo !== null) {
      setRaiseTo(legal.minRaiseTo);
    }
  }, [state?.legalActions.canRaise, state?.legalActions.minRaiseTo, state?.legalActions.maxRaiseTo]);

  useEffect(() => {
    if (roomId && socketReady && !joinedRoomId && !autoJoinAttemptedRef.current) {
      autoJoinAttemptedRef.current = true;
      if (savedNicknameRef.current.trim()) {
        void joinRoom(roomId, savedNicknameRef.current);
      }
    }
  }, [roomId, joinedRoomId, socketReady]);

  async function createRoom() {
    setIsCreating(true);
    try {
      const response = await fetch("/api/rooms", { method: "POST" });
      if (!response.ok) {
        throw new Error("创建房间失败。");
      }
      const room = (await response.json()) as CreateRoomResponse;
      window.location.href = room.url;
    } catch (error) {
      showToast(setToast, error instanceof Error ? error.message : "创建房间失败。");
    } finally {
      setIsCreating(false);
    }
  }

  async function joinRoom(targetRoomId = roomId, name = nickname) {
    if (!targetRoomId || !socketRef.current) {
      return;
    }

    const cleanName = name.trim();
    if (!cleanName) {
      showToast(setToast, "请输入昵称。");
      return;
    }

    setIsJoining(true);
    localStorage.setItem("texas:nickname", cleanName);
    const token = getOrCreateToken(targetRoomId);
    socketRef.current.emit("room:join", { roomId: targetRoomId, nickname: cleanName, token }, (ack) => {
      setIsJoining(false);
      if (!ack.ok) {
        showToast(setToast, ack.message || "加入房间失败。");
      }
    });
  }

  function emit(event: keyof ClientToServerEvents, payload: Record<string, unknown> = {}) {
    if (!roomId || !socketRef.current) {
      return;
    }
    const socket = socketRef.current as unknown as {
      emit: (eventName: string, eventPayload: Record<string, unknown>) => void;
    };
    socket.emit(event, { roomId, ...payload });
  }

  const currentTurnName = useMemo(() => {
    if (!state || state.currentTurnSeat === null) {
      return "无";
    }
    return state.seats[state.currentTurnSeat]?.nickname ?? "无";
  }, [state]);
  const isYourTurn = Boolean(state?.legalActions.isYourTurn);

  if (!roomId) {
    return (
      <div className="app-shell">
        <TopBar />
        <main className="home-grid">
          <section className="home-panel">
            <p className="eyebrow">私人牌桌</p>
            <h1>德州扑克</h1>
            <div className="home-actions">
              <button className="primary-button" onClick={createRoom} disabled={isCreating}>
                <Plus size={18} />
                {isCreating ? "创建中" : "创建牌桌"}
              </button>
            </div>
          </section>
          <section className="felt-preview" aria-label="牌桌预览">
            <div className="preview-card red">A♥</div>
            <div className="preview-card">K♠</div>
            <div className="preview-pot">1000</div>
          </section>
        </main>
        <Toast message={toast} onClose={() => setToast(null)} />
      </div>
    );
  }

  const isJoined = joinedRoomId === roomId && state?.you;

  return (
    <div className="app-shell">
      <TopBar roomId={roomId} onCopy={() => copyRoomLink(setToast)} />
      {!isJoined ? (
        <main className="join-screen">
          <section className="join-panel">
            <p className="eyebrow">房间 {roomId}</p>
            <h1>进入牌桌</h1>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void joinRoom();
              }}
            >
              <label htmlFor="nickname">昵称</label>
              <input
                id="nickname"
                value={nickname}
                maxLength={18}
                autoComplete="nickname"
                onChange={(event) => setNickname(event.target.value)}
                placeholder="输入昵称"
              />
              <button className="primary-button" disabled={isJoining}>
                <Armchair size={18} />
                {isJoining ? "进入中" : "进入房间"}
              </button>
            </form>
          </section>
        </main>
      ) : (
        <main className="table-layout">
          <section className="table-zone">
            <div className="table-status">
              <span>{phaseLabels[state.phase]}</span>
              <span>底池 {state.pot}</span>
              <span key={turnPulseKey} className={isYourTurn ? "status-turn yours" : "status-turn"} aria-live="polite">
                轮到 {currentTurnName}
              </span>
            </div>
            <div className="poker-table">
              <div className="community">
                {Array.from({ length: 5 }).map((_, index) => (
                  <CardView
                    key={index}
                    card={state.communityCards[index] ?? null}
                    reveal={animatedCommunityIndexes.includes(index)}
                  />
                ))}
              </div>
              <div key={potPulseKey} className="pot-stack">
                <CircleDollarSign size={22} />
                <strong>{state.pot}</strong>
              </div>
              {state.seats.map((seat, index) => (
                <SeatView
                  key={index}
                  seat={seat}
                  seatIndex={index}
                  isMe={state.you?.seatIndex === index}
                  isBetAnimating={animatedBetSeatIndexes.includes(index)}
                  canSit={!seat && ["waiting", "handComplete"].includes(state.phase)}
                  onSit={() => emit("seat:take", { seatIndex: index })}
                />
              ))}
            </div>
          </section>

          <aside className="side-rail">
            <section className="panel">
              <div className="panel-title">
                <span>牌局</span>
                <button className="icon-button" onClick={() => copyRoomLink(setToast)} title="复制链接">
                  <Copy size={17} />
                </button>
              </div>
              <div className="stat-grid">
                <div>
                  <span>手牌</span>
                  <strong>{state.handNumber}</strong>
                </div>
                <div>
                  <span>盲注</span>
                  <strong>
                    {state.settings.smallBlind}/{state.settings.bigBlind}
                  </strong>
                </div>
                <div>
                  <span>筹码</span>
                  <strong>{state.settings.startingStack}</strong>
                </div>
                <div>
                  <span>人数</span>
                  <strong>{state.seats.filter(Boolean).length}/6</strong>
                </div>
              </div>
              <div className="host-actions">
                {state.you?.isHost && state.canStart && (
                  <button
                    className="primary-button"
                    onClick={() => emit(state.phase === "handComplete" ? "game:nextHand" : "game:start")}
                  >
                    {state.phase === "handComplete" ? <RotateCcw size={18} /> : <Play size={18} />}
                    {state.phase === "handComplete" ? "下一手" : "开始牌局"}
                  </button>
                )}
                {state.you?.seatIndex !== null && ["waiting", "handComplete"].includes(state.phase) && (
                  <button className="ghost-button" onClick={() => emit("seat:leave")}>
                    <LogOut size={17} />
                    离座
                  </button>
                )}
              </div>
            </section>

            <ActionPanel
              state={state}
              raiseTo={raiseTo}
              setRaiseTo={setRaiseTo}
              onFold={() => emit("action:fold")}
              onCheckCall={() => emit("action:checkCall")}
              onRaise={() => emit("action:betRaise", { amount: raiseTo })}
              onAllIn={() => emit("action:allIn")}
            />

            <section className="panel log-panel">
              <div className="panel-title">记录</div>
              <ol>
                {state.logs
                  .slice()
                  .reverse()
                  .map((entry) => (
                    <li key={entry.id}>{entry.message}</li>
                  ))}
              </ol>
            </section>
          </aside>
        </main>
      )}
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}

function TopBar({ roomId, onCopy }: { roomId?: string; onCopy?: () => void }) {
  return (
    <header className="top-bar">
      <a className="brand" href="/">
        德州扑克
      </a>
      {roomId && (
        <div className="room-chip">
          <span>{roomId}</span>
          <button className="icon-button" onClick={onCopy} title="复制链接">
            <Copy size={16} />
          </button>
        </div>
      )}
    </header>
  );
}

function SeatView({
  seat,
  seatIndex,
  isMe,
  isBetAnimating,
  canSit,
  onSit
}: {
  seat: PublicRoomState["seats"][number];
  seatIndex: number;
  isMe: boolean;
  isBetAnimating: boolean;
  canSit: boolean;
  onSit: () => void;
}) {
  const positionClass = `seat-position-${seatIndex}`;

  if (!seat) {
    return (
      <div className={`seat empty ${positionClass}`}>
        <button disabled={!canSit} onClick={onSit}>
          <Armchair size={18} />
          坐下
        </button>
      </div>
    );
  }

  return (
    <div className={`seat occupied ${positionClass} ${isMe ? "me" : ""} ${seat.isTurn ? "turn" : ""}`}>
      <div className="seat-topline">
        <strong>{seat.nickname}</strong>
        <span className={seat.connected ? "online" : "offline"}>{seat.connected ? "在线" : "离线"}</span>
      </div>
      <div className="badges">
        {seat.isDealer && <span>D</span>}
        {seat.isSmallBlind && <span>SB</span>}
        {seat.isBigBlind && <span>BB</span>}
        {isMe && <span>我</span>}
      </div>
      <div className="mini-cards">
        {seat.hasCards ? (
          seat.cards ? (
            seat.cards.map((card) => <CardView key={card} card={card} compact />)
          ) : (
            <>
              <CardBack />
              <CardBack />
            </>
          )
        ) : (
          <span className="no-cards">未发牌</span>
        )}
      </div>
      <div className="seat-footer">
        <span>{seat.chips}</span>
        {seat.currentBet > 0 && <span className={isBetAnimating ? "bet-chip animate" : "bet-chip"}>下注 {seat.currentBet}</span>}
      </div>
      {seat.lastAction && <div className="last-action">{seat.lastAction}</div>}
      {seat.handDescription && <div className="hand-rank">{seat.handDescription}</div>}
    </div>
  );
}

function ActionPanel({
  state,
  raiseTo,
  setRaiseTo,
  onFold,
  onCheckCall,
  onRaise,
  onAllIn
}: {
  state: PublicRoomState;
  raiseTo: number;
  setRaiseTo: (value: number) => void;
  onFold: () => void;
  onCheckCall: () => void;
  onRaise: () => void;
  onAllIn: () => void;
}) {
  const legal = state.legalActions;
  const secondsLeft =
    legal.isYourTurn && state.actionDeadlineAt
      ? Math.max(0, Math.ceil((state.actionDeadlineAt - Date.now()) / 1000))
      : null;

  return (
    <section className={`panel action-panel ${legal.isYourTurn ? "active" : ""}`}>
      <div className="panel-title">
        <span>{legal.isYourTurn ? "轮到你" : "行动"}</span>
        {secondsLeft !== null && <strong>{secondsLeft}s</strong>}
      </div>
      <div className="action-buttons">
        <button className="danger-button" disabled={!legal.canFold} onClick={onFold}>
          弃牌
        </button>
        <button className="ghost-button" disabled={!legal.canCheck && !legal.canCall} onClick={onCheckCall}>
          {legal.canCheck ? "过牌" : `跟注 ${legal.callAmount}`}
        </button>
        <button className="ghost-button" disabled={!legal.canAllIn} onClick={onAllIn}>
          全下
        </button>
      </div>
      {legal.canRaise && legal.minRaiseTo !== null && legal.maxRaiseTo !== null && (
        <div className="raise-control">
          <div className="raise-line">
            <span>加注到</span>
            <input
              type="number"
              min={legal.minRaiseTo}
              max={legal.maxRaiseTo}
              value={raiseTo}
              onChange={(event) => setRaiseTo(clampNumber(event.target.value, legal.minRaiseTo!, legal.maxRaiseTo!))}
            />
          </div>
          <input
            type="range"
            min={legal.minRaiseTo}
            max={legal.maxRaiseTo}
            value={raiseTo}
            onChange={(event) => setRaiseTo(Number(event.target.value))}
          />
          <button className="primary-button" onClick={onRaise}>
            下注/加注
          </button>
        </div>
      )}
    </section>
  );
}

function CardView({ card, compact = false, reveal = false }: { card: Card | null; compact?: boolean; reveal?: boolean }) {
  if (!card) {
    return <div className={`card placeholder ${compact ? "compact" : ""}`} />;
  }

  const rank = card[0];
  const suit = card[1];
  const isRed = suit === "h" || suit === "d";

  return (
    <div className={`card ${isRed ? "red" : ""} ${compact ? "compact" : ""} ${reveal ? "reveal" : ""}`}>
      <span>{rankLabels[rank]}</span>
      <strong>{suitLabels[suit]}</strong>
    </div>
  );
}

function CardBack() {
  return <div className="card compact back" />;
}

function Toast({ message, onClose }: { message: string | null; onClose: () => void }) {
  useEffect(() => {
    if (!message) {
      return;
    }
    const timer = window.setTimeout(onClose, 2800);
    return () => window.clearTimeout(timer);
  }, [message, onClose]);

  return message ? <div className="toast">{message}</div> : null;
}

function getRoomIdFromPath(): string | null {
  const match = window.location.pathname.match(/^\/room\/([^/]+)/);
  return match?.[1] ?? null;
}

function getOrCreateToken(roomId: string): string {
  const key = `texas:token:${roomId}`;
  const existing = localStorage.getItem(key);
  if (existing) {
    return existing;
  }

  const token = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(key, token);
  return token;
}

function copyRoomLink(setToast: (message: string | null) => void): void {
  void navigator.clipboard.writeText(window.location.href);
  showToast(setToast, "链接已复制。");
}

function showToast(setToast: (message: string | null) => void, message: string): void {
  setToast(null);
  window.setTimeout(() => setToast(message), 10);
}

function queueTableAnimations(
  previous: PublicRoomState | null,
  next: PublicRoomState,
  controls: {
    setAnimatedCommunityIndexes: (indexes: number[]) => void;
    setAnimatedBetSeatIndexes: (indexes: number[]) => void;
    setPotPulseKey: (key: number) => void;
    setTurnPulseKey: (key: number) => void;
    timers: number[];
  }
): void {
  if (!previous || previous.roomId !== next.roomId || previous.handNumber !== next.handNumber) {
    controls.setTurnPulseKey(Date.now());
    return;
  }

  const newCommunityIndexes = next.communityCards
    .map((card, index) => ({ card, index }))
    .filter(({ card, index }) => card && previous.communityCards[index] !== card)
    .map(({ index }) => index);

  if (newCommunityIndexes.length > 0) {
    controls.setAnimatedCommunityIndexes(newCommunityIndexes);
    controls.timers.push(window.setTimeout(() => controls.setAnimatedCommunityIndexes([]), 1300));
  }

  const betIndexes = next.seats
    .map((seat, index) => ({ seat, index }))
    .filter(({ seat, index }) => {
      const previousSeat = previous.seats[index];
      return Boolean(seat && previousSeat && seat.currentBet > previousSeat.currentBet);
    })
    .map(({ index }) => index);

  if (betIndexes.length > 0) {
    controls.setAnimatedBetSeatIndexes(betIndexes);
    controls.timers.push(window.setTimeout(() => controls.setAnimatedBetSeatIndexes([]), 900));
  }

  if (next.pot !== previous.pot) {
    controls.setPotPulseKey(Date.now());
  }

  if (next.currentTurnSeat !== previous.currentTurnSeat) {
    controls.setTurnPulseKey(Date.now());
  }
}

function clampNumber(value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
