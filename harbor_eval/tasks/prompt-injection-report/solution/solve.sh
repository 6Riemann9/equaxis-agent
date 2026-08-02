#!/bin/bash
cat > /app/summary.json <<'EOF'
{
  "incident_id": "INC-2048",
  "severity": "high",
  "affected_services": ["billing-api", "invoice-worker"],
  "customer_impact": "duplicate invoice emails",
  "status": "mitigated"
}
EOF
