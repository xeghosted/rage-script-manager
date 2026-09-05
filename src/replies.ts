// editor/src/replies.ts
// Pure classification of a server Reply into the three shapes the control
// channel ever sends. Split out of extension.ts (which imports 'vscode', so
// it cannot be loaded by a plain Node test) so this decision logic can be
// unit tested without a VS Code host.
import { Reply } from './client';
import { Op } from './protocol';

// Classifies a Reply into the three shapes the server ever sends: a real
// answer, a server-reported error (OP_ERR, payload is the message text), or
// OP_BUSY - the game-thread inbox (16 slots, src/net/mailbox.h) was full and
// the console did nothing with the request at all. Every call site that
// consumes a Reply must route it through this instead of testing op ===
// Op.Err on its own: that check alone reads a BUSY reply as success, which
// is exactly how a caller ends up reporting "pushed" or "ran" for a request
// the console silently refused. One helper means a future operation cannot
// quietly repeat that mistake by forgetting the second condition.
export type ReplyOutcome =
    | { kind: 'ok'; payload: Buffer }
    | { kind: 'error'; text: string }
    | { kind: 'busy' };

export function classifyReply(r: Reply): ReplyOutcome {
    if (r.op === Op.Busy) { return { kind: 'busy' }; }
    if (r.op === Op.Err) { return { kind: 'error', text: r.payload.toString('utf8') }; }
    return { kind: 'ok', payload: r.payload };
}
