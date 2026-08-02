import assert from 'node:assert/strict';import {solve} from '/app/solution.mjs';assert.deepEqual(await solve(["a","b","a"]),{"a":2,"b":1});
