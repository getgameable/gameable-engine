import { memoryStore } from './MemoryStore.js';
import { storeContract } from './storeContract.js';

storeContract('memory', () => Promise.resolve(memoryStore()));
