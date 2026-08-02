#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export function solve(o,p='',r={}){for(const [k,v] of Object.entries(o)){const q=p?`${p}.${k}`:k;if(v&&typeof v==='object'&&!Array.isArray(v))solve(v,q,r);else r[q]=v;}return r;}
EOF
