import type { ICredentialTypeDescription, IDataObject } from '@8n8/workflow';
import { create } from 'zustand';
import { Api, type CredentialSummary, type NodeTypeDescription } from '../lib/api';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  title: string;
  message?: string;
}

interface AppState {
  loaded: boolean;
  settings: IDataObject;
  nodeTypes: Record<string, NodeTypeDescription>;
  credentialTypes: Record<string, ICredentialTypeDescription>;
  credentials: CredentialSummary[];
  toasts: Toast[];
  load(): Promise<void>;
  refreshCredentials(): Promise<void>;
  toast(kind: Toast['kind'], title: string, message?: string): void;
  dismiss(id: number): void;
}

let toastId = 0;

export const useApp = create<AppState>((set, get) => ({
  loaded: false,
  settings: {},
  nodeTypes: {},
  credentialTypes: {},
  credentials: [],
  toasts: [],
  async load() {
    const [settings, nodeTypes, credentialTypes, credentials] = await Promise.all([Api.settings(), Api.nodeTypes(), Api.credentialTypes(), Api.credentials()]);
    set({
      loaded: true,
      settings,
      nodeTypes: Object.fromEntries(nodeTypes.map((t) => [t.name, t])),
      credentialTypes: Object.fromEntries(credentialTypes.map((t) => [t.name, t])),
      credentials,
    });
  },
  async refreshCredentials() {
    set({ credentials: await Api.credentials() });
  },
  toast(kind, title, message) {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, kind, title, message }] });
    setTimeout(() => get().dismiss(id), kind === 'error' ? 8000 : 4000);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

/** Accepts both 8n8 names and n8n export names. */
export function getNodeType(type: string): NodeTypeDescription | undefined {
  const types = useApp.getState().nodeTypes;
  return types[type] ?? types[type.replace(/^n8n-nodes-base\./, '8n8.')];
}

export const errorToast = (title: string) => (e: unknown) => useApp.getState().toast('error', title, (e as Error).message);
