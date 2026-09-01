// Public surface of the bundle the panel loads.
//
// Exactly two exports, because the panel's content-provider contract is mount/teardown plus
// an agent-drive facade — see `panel/pane.js`. Everything else stays inside the bundle.
//
// Phase 3 fills this in. The signature is fixed now so `panel/pane.js` can be written
// against it, and so the sync script has something real to copy.

export interface MountOptions {
  /** Where Calliope lives. Falls back to the client's default. */
  calliopeBaseUrl?: string;
  /** Send a command to the orchestrator. Supplied by the panel host. */
  callTool?: (name: string, args: unknown) => Promise<unknown>;
}

/** The methods the agent can drive, surfaced through the shell's `drive` facade. */
export interface DirectorDrive {
  outline(): Promise<unknown>;
  [method: string]: (...args: never[]) => Promise<unknown>;
}

export interface DirectorHandle {
  drive: DirectorDrive;
  teardown(): void;
}

export function mountDirector(_el: HTMLElement, _opts: MountOptions = {}): DirectorHandle {
  throw new Error("mountDirector: not implemented until Phase 3");
}
