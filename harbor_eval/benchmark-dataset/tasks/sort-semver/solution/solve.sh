#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export const solve = xs => [...xs].sort((a,b)=>{const A=a.split('.').map(Number),B=b.split('.').map(Number); return A.findIndex((x,i)=>x!==B[i])<0?0:A[A.findIndex((x,i)=>x!==B[i])]-B[A.findIndex((x,i)=>x!==B[i])];});
EOF
