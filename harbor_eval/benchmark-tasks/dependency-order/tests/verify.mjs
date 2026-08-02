import assert from 'node:assert/strict';import {solve} from '/app/solution.mjs';assert.deepEqual(await solve({"build":["lint","test"],"lint":[],"test":[]}),["lint","test","build"]);
