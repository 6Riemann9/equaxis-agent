#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export function solve(s){const r=[];let q=false,x='';for(let i=0;i<s.length;i++){if(s[i]==='"')q=!q;else if(s[i]===','&&!q){r.push(x);x='';}else x+=s[i];}r.push(x);return r;}
EOF
