import assert from 'node:assert/strict';import {solve} from '/app/solution.mjs';assert.deepEqual(await solve({"a":{"b":2},"c":[1]}),{"a.b":2,"c":[1]});
