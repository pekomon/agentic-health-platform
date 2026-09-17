#!/usr/bin/env node
import { runAuthCommand } from "./auth.js";

const [area, ...arguments_] = process.argv.slice(2);
const exitCode = area === "auth"
  ? await runAuthCommand(arguments_, (line) => process.stdout.write(`${line}\n`))
  : 2;
if (area !== "auth") process.stdout.write("Usage: health auth <login|status|logout>\n");
process.exitCode = exitCode;
