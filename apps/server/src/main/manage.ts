#!/usr/bin/env node
import { commands } from './manageCommands';

// Django-style management command entrypoint; bare run lists commands.
// @see #322
const [name, ...args] = process.argv.slice(2);

const command = name ? commands[name] : undefined;
if (!command) {
  if (name) console.error(`Unknown command: ${name}\n`);
  console.error('Usage: npm run manage -- <command> [args]\n');
  console.error('Commands:');
  for (const [commandName, entry] of Object.entries(commands)) {
    console.error(`  ${commandName.padEnd(20)} ${entry.description}`);
  }
  process.exit(1);
}

const run = command.run(args);
if (run instanceof Promise) {
  run.catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
