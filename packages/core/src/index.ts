import { createHash } from 'node:crypto';
import { setHashImplementation } from '@8n8/workflow';

setHashImplementation((value, algorithm) => {
  const algo = algorithm === 'sha3' ? 'sha3-512' : algorithm;
  return createHash(algo).update(value).digest('hex');
});

export * from './additional-data';
export * from './binary-data';
export * from './http';
export * from './node-context';
export * from './trigger-context';
export * from './workflow-execute';
export * from './node-types';
