#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export async function solve(xs,n,f){const r=Array(xs.length),q=xs.map((_,i)=>i);await Promise.all(Array.from({length:Math.min(n,xs.length)},async()=>{while(q.length){const i=q.shift();r[i]=await f(xs[i]);}}));return r;}
EOF
