import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

const files = walk(srcRoot);
let bad = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (/\t/.test(text)) {
    console.error(`tabs not allowed: ${file}`);
    bad++;
  }
}
if (bad) process.exit(1);
console.log(`lint ok (${files.length} files)`);
