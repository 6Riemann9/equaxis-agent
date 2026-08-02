import assert from 'node:assert/strict';import {solve} from '/app/solution.mjs';assert.deepEqual(await solve("/a//b/../c"),"/a/c");
