#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export function solve(xs){const a=xs.map(x=>[...x]).sort((x,y)=>x[0]-y[0]),r=[];for(const x of a){const p=r.at(-1);if(p&&x[0]<=p[1])p[1]=Math.max(p[1],x[1]);else r.push(x);}return r;}
EOF
