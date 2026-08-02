#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export const solve=(xs,page,size)=>page<1||size<1?[]:xs.slice((page-1)*size,page*size);
EOF
