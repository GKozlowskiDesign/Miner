// src/index.ts
/* eslint-disable no-console */

// Read env (keep your already-set values)
const WALLET = process.env.WALLET || 'DEMO_WALLET';
const HOST_ID = process.env.HOST_ID || 'HOST-LOCAL';
const COORD   = process.env.COORD   || 'http://localhost:8787';

console.log(`[miner] starting with WALLET=${WALLET} HOST_ID=${HOST_ID} COORD=${COORD} SMI=${process.env.SMI ?? 'false'}`);

// simple jitter helper
const jitter = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1));

async function postShare() {
  try {
    const difficulty = jitter(1, 5); // simulate work score
    const r = await fetch(`${COORD}/share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: WALLET, hostId: HOST_ID, difficulty })
    });

    const j = await r.json();
    if (!r.ok) {
      console.error('[miner] share failed', j);
      return;
    }
    console.log(`[miner] share ok  diff=${difficulty}  total=${j.total}`);
  } catch (e) {
    console.error('[miner] share error', (e as Error).message);
  }
}

// kick off a steady stream of “work shares”
setInterval(postShare, 5000);
postShare(); // immediate first share

process.on('unhandledRejection', (e) => {
  console.error('[miner] unhandled', e);
});
