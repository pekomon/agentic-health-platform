#!/usr/bin/env node
import { runAuthCommand } from "./auth.js";
import { runInspectCommand } from "./inspect.js";

const [area, ...arguments_] = process.argv.slice(2);
const exitCode = area === "auth"
  ? await runAuthCommand(arguments_, (line) => process.stdout.write(`${line}\n`))
  : area === "inspect"
    ? await runInspectCommand(arguments_, (line) => process.stdout.write(`${line}\n`))
    : 2;
if (area !== "auth" && area !== "inspect") process.stdout.write("Usage: health <auth|inspect> ...\n");
process.exitCode = exitCode;
