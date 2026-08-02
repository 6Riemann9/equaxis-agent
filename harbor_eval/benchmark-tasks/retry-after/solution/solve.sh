#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export function solve(s){if(!/^d+$/.test(s))return null;const n=Number(s);return n>=0?n:null;}
EOF
