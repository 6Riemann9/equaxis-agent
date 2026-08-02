import assert from 'node:assert/strict';import {solve} from '/app/solution.mjs';assert.deepEqual(await solve("Bearer abc password=hunter2"),"Bearer [REDACTED] password=[REDACTED]");
