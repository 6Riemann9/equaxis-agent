import assert from 'node:assert/strict';import {solve} from '/app/solution.mjs';assert.deepEqual(await solve({"a/b":{"~x":7}},"/a~1b/~0x"),7);
