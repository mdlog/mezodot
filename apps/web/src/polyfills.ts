// Node globals expected by Mezo Passport's Bitcoin wallet dependencies. Imported first in main.tsx.
import { Buffer } from 'buffer';
import process from 'process';

const g = globalThis as unknown as { Buffer?: typeof Buffer; process?: typeof process; global?: typeof globalThis };
g.global ??= globalThis;
g.Buffer ??= Buffer;
g.process ??= process;
