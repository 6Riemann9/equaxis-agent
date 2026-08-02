#!/bin/bash
cat > /app/solution.mjs <<'EOF'
import fs from 'node:fs/promises'; export async function solve(file,text){const tmp=file+'.tmp';await fs.writeFile(tmp,text);await fs.rename(tmp,file);}
EOF
