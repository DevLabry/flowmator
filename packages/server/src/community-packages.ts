import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CredentialTypesRegistry, NodeTypesRegistry } from '@8n8/core';
import * as workflow from '@8n8/workflow';
import type { ICredentialType, IDataObject, INode, INodeType } from '@8n8/workflow';
import type { EventBus } from './events';

const run = promisify(execFile);

export interface InstalledPackage {
  packageName: string;
  installedVersion: string;
  installedNodes: Array<{ name: string; type: string; latestVersion: number }>;
  credentials: string[];
  failedLoading?: string;
  updateAvailable?: string;
}

const CONNECTION_TYPES = {
  Main: 'main',
  AiAgent: 'ai_agent',
  AiChain: 'ai_chain',
  AiDocument: 'ai_document',
  AiEmbedding: 'ai_embedding',
  AiLanguageModel: 'ai_languageModel',
  AiMemory: 'ai_memory',
  AiOutputParser: 'ai_outputParser',
  AiRetriever: 'ai_retriever',
  AiReranker: 'ai_reranker',
  AiTextSplitter: 'ai_textSplitter',
  AiTool: 'ai_tool',
  AiVectorStore: 'ai_vectorStore',
} as const;

class ApplicationError extends Error {
  constructor(message: string, readonly extra?: IDataObject) {
    super(message);
    this.name = 'ApplicationError';
  }
}

/** n8n's NodeApiError takes the raw error payload; ours takes an Error, so payloads are wrapped. */
class CompatNodeApiError extends workflow.NodeApiError {
  constructor(node: INode, error: IDataObject | Error, options: { message?: string; description?: string; itemIndex?: number; httpCode?: string } = {}) {
    const e = error instanceof Error ? error : Object.assign(new Error(options.message ?? String(error.message ?? error.description ?? 'The service returned an error')), error);
    super(node, e as Error & { statusCode?: number }, options);
    if (options.message) this.message = options.message;
    if (options.httpCode) this.httpCode = options.httpCode;
  }
}

const noop = () => {};

/** What community nodes get when they import "n8n-workflow". */
export const n8nWorkflowShim: IDataObject = {
  ...workflow,
  NodeApiError: CompatNodeApiError,
  ApplicationError,
  NodeConnectionTypes: CONNECTION_TYPES,
  NodeConnectionType: CONNECTION_TYPES,
  BINARY_ENCODING: 'base64',
  LoggerProxy: { debug: noop, info: noop, warn: console.warn, error: console.error, verbose: noop },
  deepCopy: <T>(v: T): T => structuredClone(v),
  jsonParse: (s: string, o?: { fallbackValue?: unknown; errorMessage?: string }) => {
    try {
      return JSON.parse(s);
    } catch (e) {
      if (o && 'fallbackValue' in o) return o.fallbackValue;
      throw new ApplicationError(o?.errorMessage ?? (e as Error).message);
    }
  },
  jsonStringify: (v: unknown) => JSON.stringify(v),
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  isObjectEmpty: (o: object) => !o || Object.keys(o).length === 0,
  randomString: (length: number) => Array.from({ length }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join(''),
  updateDisplayOptions: (displayOptions: IDataObject, properties: IDataObject[]) =>
    properties.map((p) => ({ ...p, displayOptions: { ...(p.displayOptions as IDataObject), ...displayOptions } })),
};

const SHIM_ID = '\0n8n-workflow-shim';
let shimInstalled = false;

/** Makes require('n8n-workflow') inside community packages return the shim. */
function installShim() {
  if (shimInstalled) return;
  shimInstalled = true;
  const M = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string; _cache: Record<string, unknown> };
  const original = M._resolveFilename;
  M._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === 'n8n-workflow') return SHIM_ID;
    return original.call(this, request, ...rest);
  };
  const mod = new Module(SHIM_ID);
  mod.exports = n8nWorkflowShim;
  mod.loaded = true;
  M._cache[SHIM_ID] = mod;
}

/** A VersionedNodeType becomes its current version with the shared description merged in. */
function resolveVersioned(instance: IDataObject): INodeType {
  if (!instance.nodeVersions) return instance as unknown as INodeType;
  const versions = instance.nodeVersions as Record<string, INodeType>;
  const current = Number(instance.currentVersion ?? Math.max(...Object.keys(versions).map(Number)));
  const node = versions[current];
  const base = (instance.description ?? {}) as IDataObject;
  node.description = { ...base, ...node.description, version: Object.keys(versions).map(Number) } as INodeType['description'];
  return node;
}

/**
 * Community node packages (npm packages with an "n8n" section in package.json), installed into
 * <userFolder>/nodes like n8n does. Node types are registered as "<package>.<node>".
 */
export class CommunityPackagesService {
  readonly dir: string;
  private readonly installed = new Map<string, InstalledPackage>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    userFolder: string,
    private readonly nodeTypes: NodeTypesRegistry,
    private readonly credentialTypes: CredentialTypesRegistry,
    private readonly events?: EventBus,
    /** npm runner, swappable in tests */
    private readonly npm: (args: string[], cwd: string) => Promise<string> = async (args, cwd) => (await run('npm', args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout,
  ) {
    this.dir = path.join(userFolder, 'nodes');
  }

  private ensureDir() {
    mkdirSync(this.dir, { recursive: true });
    const pkg = path.join(this.dir, 'package.json');
    if (!existsSync(pkg)) writeFileSync(pkg, JSON.stringify({ name: 'installed-nodes', private: true, dependencies: {} }, null, 2));
  }

  private manifest(): { dependencies?: Record<string, string> } {
    const pkg = path.join(this.dir, 'package.json');
    return existsSync(pkg) ? JSON.parse(readFileSync(pkg, 'utf8')) : {};
  }

  list(): InstalledPackage[] {
    return [...this.installed.values()].sort((a, b) => a.packageName.localeCompare(b.packageName));
  }

  /** Loads every package recorded in <userFolder>/nodes/package.json (at startup). */
  loadAll() {
    for (const name of Object.keys(this.manifest().dependencies ?? {})) {
      try {
        this.load(name);
      } catch (e) {
        this.installed.set(name, { packageName: name, installedVersion: this.manifest().dependencies?.[name] ?? '', installedNodes: [], credentials: [], failedLoading: (e as Error).message });
        console.error(`Community package ${name} not loaded: ${(e as Error).message}`);
      }
    }
  }

  /** Registers a package's nodes and credentials. */
  load(packageName: string): InstalledPackage {
    installShim();
    const pkgDir = path.join(this.dir, 'node_modules', packageName);
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { version: string; n8n?: { nodes?: string[]; credentials?: string[] } };
    if (!pkg.n8n?.nodes?.length) throw new Error(`${packageName} is not an n8n community node package (no "n8n.nodes" in package.json)`);
    const req = createRequire(path.join(pkgDir, 'package.json'));
    const instantiate = (file: string) => {
      const exported = req(path.resolve(pkgDir, file)) as Record<string, unknown>;
      return Object.values(exported)
        .filter((v): v is new () => IDataObject => typeof v === 'function')
        .map((C) => new C());
    };

    const credentials: ICredentialType[] = (pkg.n8n.credentials ?? []).flatMap((f) => instantiate(f) as unknown as ICredentialType[]).filter((c) => c.name && c.properties);
    this.credentialTypes.registerAll(credentials);

    const nodes: InstalledPackage['installedNodes'] = [];
    for (const file of pkg.n8n.nodes) {
      for (const instance of instantiate(file)) {
        const node = resolveVersioned(instance);
        if (!node.description?.name) continue;
        const type = `${packageName}.${node.description.name}`;
        node.description = { ...node.description, name: type };
        this.nodeTypes.register(node);
        const version = node.description.version;
        nodes.push({ name: node.description.displayName, type, latestVersion: Array.isArray(version) ? Math.max(...version) : Number(version ?? 1) });
      }
    }
    const info: InstalledPackage = { packageName, installedVersion: pkg.version, installedNodes: nodes, credentials: credentials.map((c) => c.name) };
    this.installed.set(packageName, info);
    return info;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => {});
    return next;
  }

  /** Installs from npm (or a local path/tarball for development) and loads it. */
  install(spec: string, version?: string) {
    return this.exclusive(async () => {
      const name = packageNameOf(spec);
      if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?n8n-nodes-/.test(name) && !spec.startsWith('file:') && !path.isAbsolute(spec)) {
        throw new Error('Community node packages are named n8n-nodes-* or @scope/n8n-nodes-*');
      }
      if (this.installed.has(name) && !this.installed.get(name)!.failedLoading) throw new Error(`${name} is already installed`);
      this.ensureDir();
      // lifecycle scripts stay off, like n8n's verified install
      await this.npm(['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', version ? `${spec}@${version}` : spec], this.dir);
      const installedName = name.startsWith('file:') || path.isAbsolute(spec) ? this.nameFromPath(spec) : name;
      try {
        const info = this.load(installedName);
        this.events?.emit('n8n.audit.package.installed', { packageName: installedName, packageVersion: info.installedVersion });
        return info;
      } catch (e) {
        await this.npm(['uninstall', '--no-audit', '--no-fund', installedName], this.dir).catch(() => '');
        throw e;
      }
    });
  }

  private nameFromPath(spec: string) {
    const dir = spec.replace(/^file:/, '');
    return (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name: string }).name;
  }

  /** Removes the package; its node types stay registered until restart, so open workflows don't break mid-run. */
  uninstall(packageName: string) {
    return this.exclusive(async () => {
      const info = this.installed.get(packageName);
      if (!info) throw new Error(`${packageName} is not installed`);
      await this.npm(['uninstall', '--no-audit', '--no-fund', packageName], this.dir);
      this.installed.delete(packageName);
      this.events?.emit('n8n.audit.package.uninstalled', { packageName, packageVersion: info.installedVersion });
    });
  }

  update(packageName: string, version = 'latest') {
    return this.exclusive(async () => {
      if (!this.installed.has(packageName)) throw new Error(`${packageName} is not installed`);
      await this.npm(['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', `${packageName}@${version}`], this.dir);
      // a fresh require: drop the cached modules of this package
      const root = path.join(this.dir, 'node_modules', packageName) + path.sep;
      const cache = (Module as unknown as { _cache: Record<string, unknown> })._cache;
      for (const k of Object.keys(cache)) if (k.startsWith(root)) delete cache[k];
      return this.load(packageName);
    });
  }

  /** Latest version on the registry for every installed package. */
  async checkUpdates() {
    for (const p of this.installed.values()) {
      try {
        const latest = (await this.npm(['view', p.packageName, 'version'], this.dir)).trim();
        p.updateAvailable = latest && latest !== p.installedVersion ? latest : undefined;
      } catch {}
    }
    return this.list();
  }
}

function packageNameOf(spec: string) {
  if (spec.startsWith('file:') || path.isAbsolute(spec)) return spec;
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}
