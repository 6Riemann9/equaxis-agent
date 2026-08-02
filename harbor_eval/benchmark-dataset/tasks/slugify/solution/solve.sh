#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export const solve=s=>s.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
EOF
