import { create } from 'zustand';
import { Api, type Project, type User } from '../lib/api';

interface AuthState {
  /** 'checking' until the first answer from the server */
  status: 'checking' | 'setup' | 'signedOut' | 'signedIn';
  user: User | null;
  /** Projects the user belongs to (personal first, then teams) */
  projects: Project[];
  smtpSetup: boolean;
  init(): Promise<void>;
  signedIn(user: User): Promise<void>;
  signOut(): Promise<void>;
  /** The session ended on the server side */
  expired(): void;
  refreshProjects(): Promise<void>;
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'checking',
  user: null,
  projects: [],
  smtpSetup: false,
  async init() {
    const settings = await Api.settings();
    const um = (settings.userManagement ?? {}) as { showSetupOnFirstLoad?: boolean; smtpSetup?: boolean };
    set({ smtpSetup: !!um.smtpSetup });
    if (um.showSetupOnFirstLoad) return set({ status: 'setup' });
    const user = await Api.currentUser().catch(() => null);
    if (user) await get().signedIn(user);
    else set({ status: 'signedOut' });
  },
  async signedIn(user) {
    set({ user, status: 'signedIn' });
    await get().refreshProjects();
  },
  async signOut() {
    await Api.logout().catch(() => undefined);
    set({ status: 'signedOut', user: null, projects: [] });
  },
  expired() {
    if (get().status === 'signedIn') set({ status: 'signedOut', user: null, projects: [] });
  },
  async refreshProjects() {
    const projects = await Api.myProjects();
    set({ projects: projects.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'personal' ? -1 : 1)) });
  },
}));

export const isAdmin = (user: User | null) => user?.role === 'global:owner' || user?.role === 'global:admin';
export const useIsAdmin = () => useAuth((s) => isAdmin(s.user));
export const displayName = (u: { firstName: string | null; lastName: string | null; email: string }) => [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;

/** Display name of a project: personal projects are called after their user ("Ana Pérez <ana@…>" on the server). */
export function projectLabel(p: { name: string; type: string; id: string }) {
  const me = useAuth.getState().user;
  if (p.type === 'personal' && p.id === me?.personalProjectId) return 'Personal';
  return p.type === 'personal' ? p.name.replace(/\s*<[^>]+>$/, '') : p.name;
}

export const ROLE_LABELS: Record<string, string> = {
  'global:owner': 'Owner',
  'global:admin': 'Admin',
  'global:member': 'Member',
  'project:personalOwner': 'Owner',
  'project:admin': 'Admin',
  'project:editor': 'Editor',
  'project:viewer': 'Viewer',
};
