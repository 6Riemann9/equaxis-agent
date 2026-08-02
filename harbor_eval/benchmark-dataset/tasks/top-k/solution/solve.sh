#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export const solve=(xs,k)=>xs.filter(Number.isFinite).sort((a,b)=>b-a).slice(0,k);
EOF
