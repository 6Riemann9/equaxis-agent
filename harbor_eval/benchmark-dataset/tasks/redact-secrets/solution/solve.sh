#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export function solve(s){const parts=s.split(' ');for(let i=0;i<parts.length;i++){if(parts[i].toLowerCase()==='bearer'&&parts[i+1])parts[++i]='[REDACTED]';else if(parts[i].toLowerCase().startsWith('password='))parts[i]='password=[REDACTED]';}return parts.join(' ');}
EOF
