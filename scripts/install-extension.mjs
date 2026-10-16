// Install the packaged .vsix into an editor via its CLI (`cursor` or `code`),
// hiding the editor CLI's own Node deprecation warnings. Run after `npm run package`.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const cli = process.argv[2] ?? 'cursor';
const { name, version, publisher } = JSON.parse(readFileSync('package.json', 'utf8'));
const vsix = `${name}-${version}.vsix`;

if (!existsSync(vsix)) {
  console.error(`${vsix} not found; run "npm run package" first.`);
  process.exit(1);
}

const NOISE = /DEP0169|--trace-deprecation/;
const child = spawn(cli, ['--install-extension', vsix, '--force']);

for (const [from, to] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  let buffered = '';
  from.on('data', (chunk) => {
    const lines = (buffered + chunk).split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!NOISE.test(line)) {
        to.write(`${line}\n`);
      }
    }
  });
  from.on('end', () => {
    if (buffered && !NOISE.test(buffered)) {
      to.write(buffered);
    }
  });
}

child.on('error', (err) => {
  console.error(`Could not run "${cli}": ${err.message}. Is its shell command installed and on PATH?`);
  process.exit(1);
});
child.on('close', (code) => {
  if (code === 0) {
    console.log(`Installed ${publisher}.${name}@${version} into ${cli}. Run "Developer: Reload Window" to load it.`);
  }
  process.exit(code ?? 1);
});
