#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export function solve(o,p){if(p==='')return o;return p.slice(1).split('/').map(x=>x.replace(/~1/g,'/').replace(/~0/g,'~')).reduce((a,k)=>a[k],o);}
EOF
