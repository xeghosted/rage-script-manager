// editor/src/reslist.test.ts
// Covers parseResourceList in isolation — see reslist.ts's header comment
// for why it lives outside resources.ts (which imports 'vscode' and so
// cannot be loaded by this plain-Node runner).
import { parseResourceList } from './reslist';

let failures = 0;
function check(ok: boolean, what: string) {
    console.log(`${what.padEnd(58)} ${ok ? 'ok' : 'FAIL'}`);
    if (!ok) { failures++; }
}

function testUntruncated(): void {
    const r = parseResourceList('demo started\nother stopped\n');
    check(r.entries.length === 2, 'parseResourceList reads two entries');
    check(r.entries[0].state === 'started', '  and their state');
    check(r.truncated === false, '  and reports not truncated');

    check(parseResourceList('my resource stopped\n').entries[0].name === 'my resource',
        'splitting on the LAST space, so a name may contain one');
    check(parseResourceList('\n\n').entries.length === 0, 'ignoring blank lines');
    check(parseResourceList('garbage\n').entries.length === 0, 'and a line with no state');
}

function testTruncated(): void {
    const MARKER = '-- truncated: listing incomplete --';

    const r = parseResourceList(`demo started\nother stopped\n${MARKER}\n`);
    check(r.truncated === true, 'a trailing "--" marker line sets truncated');
    check(r.entries.length === 2, '  without adding a phantom entry for it');
    check(r.entries.every((e) => !e.name.startsWith('--')), '  and no entry name starts with "--"');
    check(r.entries[0].name === 'demo' && r.entries[1].name === 'other', '  real entries stay intact');

    // The buffer could be so small that not even one real entry fit before
    // the marker was appended (see resource_list_pack in src/script/resource.h).
    const onlyMarker = parseResourceList(`${MARKER}\n`);
    check(onlyMarker.truncated === true, 'a payload that is only the marker is still truncated');
    check(onlyMarker.entries.length === 0, '  with zero entries, not a crash or a phantom one');

    // No marker at all: an ordinary, complete listing.
    check(parseResourceList('demo started\nother stopped\n').truncated === false,
        'a payload with no marker line is not truncated');
}

testUntruncated();
testTruncated();

console.log(`\n${failures ? 'FAILED' : 'PASSED'} (${failures} failures)`);
process.exit(failures ? 1 : 0);
