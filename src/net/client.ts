import { SIM_VERSION, type SimInput, type SimState, type World } from "../sim/index.ts";
import { NET_VERSION, type Hello, type ServerMessage, type WorldName } from "./protocol.ts";
import { Prediction } from "./prediction.ts";

export interface ConnectionInfo {
  status: "offline" | "connecting" | "connected" | "recovering" | "error";
  message: string;
  code: string;
  playerId: string;
  players: Record<string, string>;
  confirmedTick: number;
  predictionTicks: number;
}

export interface ClientOptions {
  onState(state: SimState, playerId: string): void;
  onStatus(info: ConnectionInfo): void;
  onDisconnect(): void;
}

export class RelayClient {
  readonly prediction: Prediction;
  readonly info: ConnectionInfo = { status: "offline", message: "", code: "", playerId: "", players: {}, confirmedTick: 0, predictionTicks: 0 };
  private socket: WebSocket | null = null;
  private readonly options: ClientOptions;
  private readonly worldName: WorldName;
  private readonly fingerprint: string;
  private actions = 0;

  constructor(world: World, worldName: WorldName, fingerprint: string, options: ClientOptions) {
    this.options = options;
    this.worldName = worldName;
    this.fingerprint = fingerprint;
    this.prediction = new Prediction(world, () => this.send({ type: "resync" }));
  }

  connect(url: string, code?: string): void {
    if (this.socket) throw new Error("already_connected");
    this.info.status = "connecting";
    this.info.message = "Connecting…";
    this.emit();
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      const hello: Hello = { type: code ? "join" : "create", version: NET_VERSION, simVersion: SIM_VERSION, world: this.worldName, fingerprint: this.fingerprint };
      if (code) hello.code = code;
      this.send(hello);
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === "error") {
          this.info.status = "error";
          this.info.message = message.message;
          this.emit();
          return;
        }
        if (message.type === "welcome") {
          if (message.world !== this.worldName || message.fingerprint !== this.fingerprint) throw new Error("World versions do not match.");
          this.info.code = message.code;
          this.info.playerId = message.playerId;
        }
        this.prediction.receive(message);
        this.info.status = this.prediction.recovering ? "recovering" : "connected";
        this.info.message = this.prediction.recovering ? "Synchronizing…" : "Connected";
        if (this.prediction.state) this.options.onState(this.prediction.state, this.prediction.playerId);
        this.emit();
      } catch {
        this.info.status = "error";
        this.info.message = "The server sent incompatible game data.";
        this.emit();
        socket.close();
      }
    });
    socket.addEventListener("error", () => {
      this.info.status = "error";
      this.info.message = "Cannot reach the multiplayer server.";
      this.emit();
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.actions = 0;
      if (this.info.status !== "error") { this.info.status = "offline"; this.info.message = "Disconnected. Rejoin with the room code."; }
      this.emit();
      this.options.onDisconnect();
    });
  }

  sample(input: SimInput): void {
    if (this.info.status !== "connected" && this.info.status !== "recovering") return;
    this.actions |= input.actions;
    // Never consume a sequence number for an input the transport cannot send.
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount >= 32_768) { this.fellBehind(); return; }
    const accepted = this.prediction.predict({ ...input, actions: this.actions });
    if (!accepted) return;
    this.actions = 0;
    this.send({ type: "input", ...accepted });
    if (this.prediction.state) this.options.onState(this.prediction.state, this.prediction.playerId);
    this.emit();
  }

  disconnect(): void { this.socket?.close(); }
  private send(value: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount >= 32_768) { this.fellBehind(); return; }
    try { this.socket.send(JSON.stringify(value)); } catch { this.fellBehind(); }
  }
  private fellBehind(): void {
    this.info.status = "error";
    this.info.message = "Your connection fell behind. Rejoin the room.";
    this.emit();
    this.socket?.close();
  }
  private emit(): void {
    this.info.confirmedTick = this.prediction.confirmed?.tick ?? 0;
    this.info.predictionTicks = this.prediction.pending.length;
    this.info.players = { ...this.prediction.players };
    this.options.onStatus({ ...this.info, players: { ...this.info.players } });
  }
}
