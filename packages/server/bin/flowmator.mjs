#!/usr/bin/env node
// Runs the TypeScript sources directly (no build step for the server).
import { register } from 'tsx/esm/api';

register();
await import('../src/cli.ts');
