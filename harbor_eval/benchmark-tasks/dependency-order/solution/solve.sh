#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export function solve(g){const r=[],s=new Set(),d=new Set();function v(n){if(s.has(n))throw Error('Cycle');if(d.has(n))return;s.add(n);for(const x of g[n]??[])v(x);s.delete(n);d.add(n);r.push(n);}for(const n of Object.keys(g))v(n);return r;}
EOF
