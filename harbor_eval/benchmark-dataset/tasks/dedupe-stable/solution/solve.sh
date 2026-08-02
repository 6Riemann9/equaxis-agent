#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export const solve = xs => [...new Set(xs)];
EOF
