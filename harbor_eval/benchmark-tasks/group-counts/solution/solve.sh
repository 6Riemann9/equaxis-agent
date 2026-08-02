#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export function solve(xs){ return xs.reduce((a,x)=>(a[x]=(a[x]??0)+1,a),{}); }
EOF
