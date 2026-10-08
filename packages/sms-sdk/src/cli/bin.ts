#!/usr/bin/env node
import { runDoctor } from "./doctor.js";

const exitCode = await runDoctor({
  argv: process.argv.slice(2),
  env: process.env,
  io: {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  },
});
process.exitCode = exitCode;
