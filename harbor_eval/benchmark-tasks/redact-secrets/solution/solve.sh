#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export const solve=s=>s.replace(/Bearers+S+/gi,'Bearer [REDACTED]').replace(/(password=)[^s&]+/gi,'$1[REDACTED]');
EOF
