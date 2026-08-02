#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export function solve(x){const s=String(x).toLowerCase();if(['true','1','yes','on'].includes(s))return true;if(['false','0','no','off'].includes(s))return false;throw Error('Invalid boolean');}
EOF
