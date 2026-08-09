#!/usr/bin/env node
import { formatProtocolRegressionReport, runProtocolRegression } from "../src/protocol-regression.mjs";

const report = runProtocolRegression();
console.log(formatProtocolRegressionReport(report));
process.exitCode = report.ok ? 0 : report.status || 1;
