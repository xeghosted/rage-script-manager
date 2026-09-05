// editor/src/client.test.ts
// Drives Client against a fake TCP server in-process: no hardware, no game
// needed. Exercises exactly the edge cases a stream protocol gets wrong —
// split frames, coalesced frames, stale replies, timeouts, disconnects, and
// malformed frames — each written so it can actually fail if the behaviour
// the review verified by reading were ever wrong.
import * as net from 'net';
import { Client } from './client';
import { Op, encodeFrame, decodeHeader, HEADER_SIZE } from './protocol';

let failures = 0;
function check(ok: boolean, what: string) {
    console.log(`${what.padEnd(58)} ${ok ? 'ok' : 'FAIL'}`);
    if (!ok) { failures++; }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls `cond` until it's true or `timeoutMs` elapses; never hangs the suite.
async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) { return false; }
        await sleep(5);
    }
    return true;
}

function listen(): Promise<{ server: net.Server; port: number }> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const port = addr && typeof addr === 'object' ? addr.port : 0;
            resolve({ server, port });
        });
    });
}

// Waits for the client's request header (always >= HEADER_SIZE bytes, since
// the test requests below carry no payload) so a reply can be stamped with
// the seq the client actually used.
function readRequestHeader(sock: net.Socket): Promise<{ op: number; seq: number; len: number }> {
    return new Promise((resolve) => {
        let buf = Buffer.alloc(0);
        const onData = (d: Buffer) => {
            buf = Buffer.concat([buf, d]);
            if (buf.length >= HEADER_SIZE) {
                const h = decodeHeader(buf);
                if (h) {
                    sock.removeListener('data', onData);
                    resolve(h);
                }
            }
        };
        sock.on('data', onData);
    });
}

async function withServer(fn: (server: net.Server, port: number) => Promise<void>): Promise<void> {
    const { server, port } = await listen();
    try {
        await fn(server, port);
    } finally {
        server.close();
    }
}

async function testSplitFrame(): Promise<void> {
    await withServer(async (server, port) => {
        const client = new Client();
        server.on('connection', async (sock) => {
            const h = await readRequestHeader(sock);
            const frame = encodeFrame(Op.Pong, h.seq, Buffer.from('pong-data'));
            sock.write(frame.subarray(0, 6));
            await sleep(20);
            sock.write(frame.subarray(6));
        });
        try {
            await client.connect('127.0.0.1', port);
            const reply = await client.request(Op.Ping, undefined, 2000);
            check(reply.op === Op.Pong && reply.payload.toString('utf8') === 'pong-data',
                'resolves a reply whose bytes arrive split across two writes');
        } finally {
            client.disconnect();
        }
    });
}

async function testCoalescedFrames(): Promise<void> {
    await withServer(async (server, port) => {
        const client = new Client();
        let sawLog: string | null = null;
        client.on('log', (m: string) => { sawLog = m; });
        server.on('connection', async (sock) => {
            const h = await readRequestHeader(sock);
            const logFrame = encodeFrame(Op.Log, 0, Buffer.from('hello from server'));
            const replyFrame = encodeFrame(Op.Pong, h.seq, Buffer.from('ok'));
            sock.write(Buffer.concat([logFrame, replyFrame]));
        });
        try {
            await client.connect('127.0.0.1', port);
            const reply = await client.request(Op.Ping, undefined, 2000);
            check(sawLog === 'hello from server', 'fires the log event for a LOG frame coalesced with a reply');
            check(reply.op === Op.Pong && reply.payload.toString('utf8') === 'ok',
                'also resolves the request that shared the same read');
        } finally {
            client.disconnect();
        }
    });
}

async function testSplitHeaderFromBody(): Promise<void> {
    await withServer(async (server, port) => {
        const client = new Client();
        server.on('connection', async (sock) => {
            const h = await readRequestHeader(sock);
            const payload = Buffer.from('a'.repeat(50));
            const frame = encodeFrame(Op.Pong, h.seq, payload);
            sock.write(frame.subarray(0, HEADER_SIZE));
            await sleep(20);
            sock.write(frame.subarray(HEADER_SIZE));
        });
        try {
            await client.connect('127.0.0.1', port);
            const reply = await client.request(Op.Ping, undefined, 2000);
            check(reply.payload.length === 50 && reply.payload.toString('utf8') === 'a'.repeat(50),
                'resolves with the full payload when the header and body arrive in separate reads');
        } finally {
            client.disconnect();
        }
    });
}

async function testStaleReplyIgnored(): Promise<void> {
    await withServer(async (server, port) => {
        const client = new Client();
        server.on('connection', async (sock) => {
            const h = await readRequestHeader(sock);
            const staleSeq = h.seq === 1 ? 2 : 1; // any value != h.seq and != 0
            sock.write(encodeFrame(Op.Pong, staleSeq, Buffer.from('stale-payload')));
            await sleep(10);
            sock.write(encodeFrame(Op.Pong, h.seq, Buffer.from('real-payload')));
        });
        try {
            await client.connect('127.0.0.1', port);
            const reply = await client.request(Op.Ping, undefined, 2000);
            check(reply.payload.toString('utf8') === 'real-payload',
                'discards a reply for a seq nobody is waiting on and resolves with the real reply');
        } finally {
            client.disconnect();
        }
    });
}

async function testTimeoutClearsPending(): Promise<void> {
    await withServer(async (server, port) => {
        const client = new Client();
        server.on('connection', () => { /* accept, never answer */ });
        try {
            await client.connect('127.0.0.1', port);
            let rejected = false;
            try {
                await client.request(Op.Ping, undefined, 50);
            } catch {
                rejected = true;
            }
            check(rejected, 'rejects a request that never gets a reply');
            check((client as unknown as { pending: Map<unknown, unknown> }).pending.size === 0,
                'leaves no pending entry behind after the timeout');
        } finally {
            client.disconnect();
        }
    });
}

async function testDisconnectSettlesInFlightRequest(): Promise<void> {
    await withServer(async (server, port) => {
        const client = new Client();
        server.on('connection', (sock) => {
            setTimeout(() => sock.destroy(), 20);
        });
        try {
            await client.connect('127.0.0.1', port);
            const start = Date.now();
            let settled = false;
            client.request(Op.Ping, undefined, 5000).then(() => { settled = true; }, () => { settled = true; });
            const ok = await waitUntil(() => settled, 1000);
            check(ok, 'settles a pending request instead of hanging when the connection drops mid-flight');
            check(Date.now() - start < 1000, 'settles promptly rather than waiting out the request timeout');
        } finally {
            client.disconnect();
        }
    });
}

async function testMalformedFrameDisconnects(): Promise<void> {
    await withServer(async (server, port) => {
        const client = new Client();
        let sawLog: string | null = null;
        client.on('log', (m: string) => { sawLog = m; });
        server.on('connection', (sock) => {
            const bad = Buffer.alloc(HEADER_SIZE);
            bad.write('XLUA', 0, 'ascii'); // bad magic, rest zeroed
            sock.write(bad);
        });
        try {
            await client.connect('127.0.0.1', port);
            const disconnected = await waitUntil(() => !client.connected, 1000);
            check(disconnected, 'disconnects on a malformed frame instead of resyncing or spinning');
            check(sawLog !== null && /malformed/i.test(sawLog ?? ''),
                'logs a message about the malformed frame before disconnecting');
        } finally {
            client.disconnect();
        }
    });
}

async function main(): Promise<void> {
    await testSplitFrame();
    await testCoalescedFrames();
    await testSplitHeaderFromBody();
    await testStaleReplyIgnored();
    await testTimeoutClearsPending();
    await testDisconnectSettlesInFlightRequest();
    await testMalformedFrameDisconnects();

    console.log(`\n${failures ? 'FAILED' : 'PASSED'} (${failures} failures)`);
    process.exit(failures ? 1 : 0);
}

main().catch((e) => {
    console.error('client.test.ts crashed:', e);
    process.exit(1);
});
