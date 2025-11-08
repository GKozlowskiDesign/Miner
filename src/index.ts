/* eslint-disable no-console */

// ---- Env -------------------------------------------------------------------
const WALLET = process.env.WALLET || 'DEMO_WALLET';
const HOST_ID = process.env.HOST_ID || 'HOST-LOCAL';
const COORD   = process.env.COORD || process.env.COORDINATOR_URL || 'http://localhost:8787';

console.log(`[miner] boot WALLET=${WALLET} HOST_ID=${HOST_ID} COORD=${COORD}`);

// Node 18+ has global fetch. If using older Node, add:  import('node-fetch')
type HostState = { hostId: string; enabled: boolean; wallet?: string };

let enabled = false;
let lastStatePrinted = '';

// Poll /host-state to decide if we’re allowed to mine
async function refreshHostState() {
  try {
    const r = await fetch(`${COORD}/host-state?hostId=${encodeURIComponent(HOST_ID)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as HostState;
    enabled = !!j.enabled;

    const tag = enabled ? 'ENABLED' : 'DISABLED';
    const line = `[miner] host=${j.hostId} state=${tag} owner=${j.wallet ?? '-'} wallet=${WALLET}`;
    if (line !== lastStatePrinted) {
      console.log(line);
      lastStatePrinted = line;
    }
  } catch (e: any) {
    enabled = false;
    const line = `[miner] host-state error: ${e?.message || e}`;
    if (line !== lastStatePrinted) {
      console.warn(line);
      lastStatePrinted = line;
    }
  }
}

// Random “work” score to simulate difficulty
const jitter = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1));

// Only post shares when enabled === true
async function postShare() {
  if (!enabled) return; // gate
  try {
    const difficulty = jitter(1, 5);
    const r = await fetch(`${COORD}/share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: WALLET, hostId: HOST_ID, difficulty }),
    });

    const j = await r.json();
    if (!r.ok) {
      console.error('[miner] share failed', j);
      return;
    }
    console.log(`[miner] share ok diff=${difficulty} total=${j.total}`);
  } catch (e: any) {
    console.error('[miner] share error', e?.message || e);
  }
}

// Kick off loops
refreshHostState();
setInterval(refreshHostState, 4000); // check gate every 4s
setInterval(postShare, 5000);        // attempt a share every 5s (only fires if enabled)

// Safety
process.on('unhandledRejection', (e) => console.error('[miner] unhandled', e));
