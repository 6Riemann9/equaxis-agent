#!/bin/bash
cat > /app/solution.mjs <<'EOF'
import path from 'node:path'; export const solve=s=>path.posix.resolve('/',s);
EOF
