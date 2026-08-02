#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export function solve(s){const m=/^([^@]+)@([^@]+)$/.exec(s);if(!m)throw Error('Invalid email');return m[1][0]+'***@'+m[2];}
EOF
