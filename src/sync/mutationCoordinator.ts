import { App } from "obsidian";

export interface MutationLease {
  readonly app: App;
  readonly id: symbol;
  readonly label: string;
}

const activeMutations = new WeakMap<App, MutationLease>();

export function acquireMutationLease(app: App, label: string): MutationLease | undefined {
  if (activeMutations.has(app)) return undefined;

  const lease: MutationLease = { app, id: Symbol(label), label };
  activeMutations.set(app, lease);
  return lease;
}

export function ownsMutationLease(app: App, lease: MutationLease | undefined): boolean {
  return !!lease && lease.app === app && activeMutations.get(app)?.id === lease.id;
}

export function releaseMutationLease(lease: MutationLease): void {
  if (activeMutations.get(lease.app)?.id === lease.id) {
    activeMutations.delete(lease.app);
  }
}

export function getActiveMutationLabel(app: App): string | undefined {
  return activeMutations.get(app)?.label;
}
