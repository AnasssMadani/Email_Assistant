import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export interface ConnectionState {
  provider: "gmail" | "graph";
  email: string;
  connectedAt: string;
}

function statePath(): string {
  return path.resolve(config.connectionStatePath);
}

export function getConnectionState(): ConnectionState | null {
  const p = statePath();
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as ConnectionState;
}

export function saveConnectionState(state: ConnectionState): void {
  const p = statePath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
}

export function clearConnectionState(): void {
  const p = statePath();
  if (existsSync(p)) unlinkSync(p);
}
