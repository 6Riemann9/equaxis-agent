#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export function solve(x){if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.freeze(x);for(const v of Object.values(x))solve(v);}return x;}
EOF
