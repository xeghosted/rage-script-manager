// editor/src/protocol.test.ts
// Asserts the TypeScript codec against the same fixtures the C++ one uses.
// This file is the reason the two cannot drift.
import * as fs from 'fs';
import * as path from 'path';
import { Op, encodeHeader, decodeHeader, HEADER_SIZE } from './protocol';

let failures = 0;
function check(ok: boolean, what: string) {
    console.log(`${what.padEnd(58)} ${ok ? 'ok' : 'FAIL'}`);
    if (!ok) { failures++; }
}

const vectorsPath = path.join(__dirname, '..', 'test-fixtures', 'protocol_vectors.json');
const fixtures = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

check(fixtures.header_size === HEADER_SIZE, 'header size agrees with the fixture file');

// Every opcode by name, paired with the Op constant it must equal.
//
// The vector loop below reads each fixture's op NUMBER straight out of the
// JSON, so it never bound this enum to src/net/frame.h's net::op at all:
// renumbering OP_CMD on the C++ side left this suite green. `Op` was imported
// here and then never used, which is the same gap said out loud. This table
// closes it -- each language asserts its own enum against the shared fixture,
// so the two cannot disagree without one of them turning red. tests/net_test.cpp
// asserts the identical object against net::op.
const OPCODES: Record<string, Op> = {
    HELLO: Op.Hello, PING: Op.Ping, PONG: Op.Pong,
    PUT: Op.Put, GET: Op.Get, LS: Op.Ls, RM: Op.Rm,
    EXEC: Op.Exec, RELOAD: Op.Reload,
    LOG: Op.Log, EVENT: Op.Event,
    OK: Op.Ok, ERR: Op.Err, BUSY: Op.Busy,
    START: Op.Start, STOP: Op.Stop, RESTART: Op.Restart,
    RESLIST: Op.ResList, RESINFO: Op.ResInfo, CMD: Op.Cmd,
};

check(typeof fixtures.opcodes === 'object' && fixtures.opcodes !== null,
      'the fixture file carries an "opcodes" table');
for (const [name, value] of Object.entries(OPCODES)) {
    check(fixtures.opcodes?.[name] === value, `  Op.${Op[value]} is the fixture's "${name}"`);
}
// The other direction: an opcode the fixture (and net::op) has but this enum
// does not. Checking only the loop above would let one be added on the C++
// side alone and never noticed here.
const unnamed = Object.keys(fixtures.opcodes ?? {}).filter((k) => !(k in OPCODES));
check(unnamed.length === 0,
      `  and the fixture lists no opcode Op lacks (${unnamed.join(', ') || 'none'})`);

// The third direction, and the one neither of those covers: a member of Op
// that this table forgot. Both checks above compare OPCODES to the fixture,
// so an opcode added to Op (and to net::op) but to neither the tables nor
// tests/protocol_vectors.json leaves all three suites green -- they agree
// perfectly about the twenty they know. tests/net_test.cpp asserts the same
// coverage against net::op, which has a trailing OP__COUNT because C++ cannot
// enumerate an enum the way Object.keys can.
const bound = new Set<number>(Object.values(OPCODES));
const unbound = Object.keys(Op)
    .filter((k) => isNaN(Number(k)))              // names, not the reverse mappings
    .filter((k) => !bound.has(Op[k as keyof typeof Op]));
check(unbound.length === 0,
      `  and every member of Op is bound to a fixture name (${unbound.join(', ') || 'all bound'})`);

for (const v of fixtures.vectors) {
    const got = encodeHeader({ op: v.op, flags: v.flags, seq: v.seq, len: v.len }).toString('hex');
    check(got === v.hex, `encodes the "${v.name}" vector`);

    const back = decodeHeader(Buffer.from(v.hex, 'hex'));
    check(back !== null && back.op === v.op && back.seq === v.seq && back.len === v.len,
          `  and decodes it back`);
}

for (const r of fixtures.rejects) {
    check(decodeHeader(Buffer.from(r.hex, 'hex')) === null, `rejects "${r.name}"`);
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'} (${failures} failures)`);
process.exit(failures ? 1 : 0);
