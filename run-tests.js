// editor/run-tests.js
// Runs every compiled test file, in sequence, regardless of whether an
// earlier one failed, and exits non-zero if any of them did. Deliberately
// dependency-free: no test framework, just child_process against Node's own
// compiled output, matching the project's hand-rolled harness style.
const { execFileSync } = require('child_process');
const path = require('path');

const tests = ['protocol.test.js', 'client.test.js', 'reslist.test.js', 'extension.test.js', 'consoleinput.test.js', 'locate.test.js', 'scaffold.test.js'];
let failed = false;

for (const t of tests) {
    console.log(`\n=== ${t} ===`);
    try {
        execFileSync(process.execPath, [path.join(__dirname, 'out', t)], { stdio: 'inherit' });
    } catch (e) {
        failed = true;
    }
}

process.exit(failed ? 1 : 0);
