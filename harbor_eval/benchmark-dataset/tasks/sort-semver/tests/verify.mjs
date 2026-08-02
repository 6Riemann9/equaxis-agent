import assert from 'node:assert/strict';import {solve} from '/app/solution.mjs';assert.deepEqual(await solve(["1.10.0","1.2.0","2.0.0"]),["1.2.0","1.10.0","2.0.0"]);
