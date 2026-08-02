#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export function solve(s){if(String(Number(s))!==s)return null;const n=Number(s);return Number.isInteger(n)&&n>=0?n:null;}
EOF
